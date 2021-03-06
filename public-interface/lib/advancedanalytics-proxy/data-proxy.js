/**
 * Copyright (c) 2014 Intel Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';
var MQTTConnector = require('./../../lib/mqtt'),
    Kafka = require('kafka-node'),
    KafkaHLProducer = Kafka.HighLevelProducer,
    KafkaClient = Kafka.Client,
    request = require('request'),
    util = require('../dateUtil'),
    logger = require('../logger').init(),
    contextProvider = require('./../context-provider').instance(),
    errBuilder  = require("../errorHandler").errBuilder,
    Metric = require('./Metric.data').init(util),
    responses = require('./utils/responses');

var buildDIMessage = function(data) {
    var times = util.extractFromAndTo(data);

    return {
        "msgType": "basicDataInquiryRequest",
        "accountId": data.domainId,
        "startDate": times.from,
        "endDate": times.to,
        "maxPoints": data.maxItems,
        "componentsWithDataType": data.componentList
    };
};


var buildDIAMessage = function(data) {
    var times = util.extractFromAndTo(data);
    data.msgType = "advancedDataInquiryRequest";
    data.startTimestamp = times.from;
    data.endTimestamp = times.to;
    return data;
};

var buildARMessage = function(data) {
    var times = util.extractFromAndTo(data);
    data.msgType = "aggregatedReportRequest";
    data.startTimestamp = times.from;
    data.endTimestamp = times.to;
    return data;
};

var buildICFALMessage = function(data) {
    return {
        msgType: 'inquiryComponentFirstAndLastRequest',
        components: data.components || []
    };
};

module.exports = function(config) {

    var connector = new MQTTConnector.Broker(config.mqtt, logger);

    var kafkaClient, kafkaProducer;
    if (config.ingestion === 'Kafka') {
        try {
            kafkaClient = new KafkaClient(config.kafka.hosts, config.kafka.username);
        } catch (exception) {
            logger.error("Exception occured creating Kafka Client: " + exception);
        }
        try {
            kafkaProducer = new KafkaHLProducer(kafkaClient, {
                requireAcks: 1, // 1 = Leader ack required
                ackTimeoutMs: 500
            });
        } catch (exception) {
            logger.error("Exception occured creating Kafka Producer: " + exception);
        }
    }

    this.submitDataMQTT = function(data, callback){

        var dataMetric = new Metric();

        var options = {
            topic: 'server/metric/' + data.domainId + "/" + data.gatewayId,
            message: dataMetric.prepareDataIngestionMsg(data)
        };
        /**
         * Since this msg is already process by health metrics, it is set the forwarded message.
         */
        connector.publish(options.topic, options.message);

        callback(null);
    };

    this.submitDataREST = function(data, callback) {
        var dataMetric = new Metric();
        var message = dataMetric.prepareDataIngestionMsg(data);

        var options = {
            url: config.dataUrl + '/v1/accounts/' + data.domainId + '/dataSubmission',
            method: 'POST',

            headers: {
                'x-iotkit-requestid': contextProvider.get('requestid'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        };
        logger.debug("Calling proxy to submit data");
        request(options, function(err, res) {
            logger.debug("END Calling proxy to submit data");
            if (!err) {
                if (res.statusCode === responses.Success.Created) {
                    callback(null);
                } else {
                    logger.warn("Wrong response code received from AA when forwarding observations: " + res.statusCode + " : " + res.body);
                    callback(errBuilder.build(errBuilder.Errors.Data.WrongResponseCodeFromAA));
                }
            } else {
                logger.error("Could not send request to AA: " + JSON.stringify(err));
                callback(errBuilder.build(errBuilder.Errors.Data.SubmissionError));
            }
        });
    };

    this.submitDataKafka = function(data, callback){

        try {
            var dataMetric = new Metric(),
            metricsTopic = 'metrics',
            message = 'server/metric/' + data.domainId + "/" + data.gatewayId + "~@~" +JSON.stringify(dataMetric.prepareDataIngestionMsg(data));

            kafkaProducer.send([
                {
                    topic: metricsTopic,
                    messages: message
                }
            ], function (err, data) {
                if (err) {
                    logger.error("Error when forwarding observation to Kafka: " + JSON.stringify(err));
                    callback(errBuilder.build(errBuilder.Errors.Data.SubmissionError));
                } else {
                    logger.debug("Response from Kafka after sending message: " + JSON.stringify(data));
                    callback(null);
                }
            });
        } catch(exception) {
            logger.error("Exception occured when forwarding observation to Kafka: " + exception);
            callback(errBuilder.build(errBuilder.Errors.Data.SubmissionError));
        }
    };

    this.dataInquiry = function(data, callback){

        var dataInquiryMessage = buildDIMessage(data);
        if(data.queryMeasureLocation !== undefined){
            dataInquiryMessage.queryMeasureLocation = data.queryMeasureLocation;
        }

        var options = {
            url: config.url + '/v1/accounts/' + data.domainId + '/dataInquiry',
            method: 'POST',
            headers: {
                'x-iotkit-requestid': contextProvider.get('requestid'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(dataInquiryMessage)
        };
        logger.debug("data-proxy. dataInquiry, options: " + JSON.stringify(options));

        request(options, function (err, res) {
            try {
                if (!err && (res.statusCode === responses.Success.OK)) {
                    logger.debug("data-proxy. dataInquiry, Got Response from AA API: " + res.body);
                    callback(null, JSON.parse(res.body));
                } else if (!err && (res.statusCode === responses.Success.NoContent)) {
                    logger.warn("data-proxy. dataInquiry, Got No-content Response from AA API");
                    callback(null, {"components": []});
                } else if (!err && (res.statusCode === responses.Errors.BadRequest)) {
                    logger.warn("data-proxy. dataInquiry, Got Bad Request Response from AA API : " + res.body);
                    callback("BadRequest", prepareErrorMessage(res));
                } else if (!err && (res.statusCode === responses.Errors.EntityToLarge)) {
                    logger.warn("data-proxy. dataInquiry, Got Entity-too-large Response from AA API : " + res.body);
                    callback("EntityTooLarge");
                } else {                    
                    var errMsg = responses.buildErrorMessage(err, res);
                    logger.warn("data-proxy. dataInquiry, error: " + errMsg);
                    callback({message: 'error receiving data'});
                }
            } catch (e) {
                logger.error("data-proxy. dataInquiry, Could not parse AA response " + res.body + " as JSON.");
                callback({message: 'Could not parse AA response'});
            }
        });
    };

    var prepareErrorMessage = function (res) {
        var body = JSON.parse(res.body);
        var message = '';
        if (body.errors) {
            body.errors.forEach(function (error) {
                message += error.errorMessage + '. ';
            });
        }
        return message;
    };
    
    this.dataInquiryAdvanced = function(data, callback) {
        var accountId = data.accountId;
        delete data.accountId;

        var advancedDataInquiryMessage = buildDIAMessage(data);

        var options = {
            url: config.url + '/v1/accounts/' + accountId + '/dataInquiry/advanced',
            method: 'POST',
            headers: {
                'x-iotkit-requestid': contextProvider.get('requestid'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(advancedDataInquiryMessage)
        };
        logger.debug("data-proxy. dataInquiryAdvanced, options: " + JSON.stringify(options));

        request(options, function(err, res){
            try {
                if (!err && (res.statusCode === responses.Success.OK)) {
                    logger.debug("data-proxy. dataInquiryAdvanced, Got Response from AA API: " + JSON.stringify(res.body));
                    callback(null, JSON.parse(res.body));
                } else if (!err && (res.statusCode === responses.Errors.BadRequest)) {
                    logger.warn("data-proxy. dataInquiryAdvanced, Got Bad Request Response from AA API : " + res.body);
                    var message = prepareErrorMessage(res);
                    callback("BadRequest", message);
                } else if (!err && (res.statusCode === responses.Errors.EntityToLarge)) {
                    logger.warn("data-proxy. dataInquiryAdvanced, Got Entity-too-large Response from AA API : " + JSON.stringify(res.body));
                    callback("EntityTooLarge");
                } else {
                    logger.warn("data-proxy. dataInquiryAdvanced, error: " + JSON.stringify(err));
                    if (res) {
                        var error = {
                            statusCode: res.statusCode,
                            body: res.body
                        };
                        logger.warn("data-proxy. dataInquiryAdvanced, response: " + JSON.stringify(error));
                    }
                    callback({message: 'error receiving data'});
                }
            } catch (e) {
                logger.error("data-proxy. dataInquiryAdvanced, Could not parse AA response " + res.body + " as JSON.");
                callback({message: 'Could not parse AA response'});
            }
        });
    };

    this.report = function(data, callback) {

        var domainId = data.domainId;
        delete data.domainId;

        var aggregatedReportMessage = buildARMessage(data);

        var options = {
            url: config.url + '/v1/accounts/' + domainId + '/report',
            method: 'POST',
            headers: {
                'x-iotkit-requestid': contextProvider.get('requestid'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(aggregatedReportMessage)
        };
        logger.debug("data-proxy. report, options: " + JSON.stringify(options));

        request(options, function (err, res) {
            if (!err && (res.statusCode === responses.Success.OK)) {
                logger.debug("data-proxy. report, Got Response from AA API: " + JSON.stringify(res.body));
                callback(null, res.body);
            } else {
                var errMsg = responses.buildErrorMessage(err, res);
                logger.warn("data-proxy. report, error: " + errMsg);
                if (res) {
                    var error = {
                        statusCode: res.statusCode,
                        body: res.body
                    };
                    logger.warn("data-proxy. report, response: " + JSON.stringify(error));
                    if (error.statusCode === responses.Errors.BadRequest) {
                        callback(error);
                        return;
                    }
                }
                callback({message: 'error receiving data'});
            }
        });
    };

    this.getFirstAndLastMeasurement = function(data, callback) {

        var domainId = data.domainId;
        delete data.domainId;

        var inquiryComponentFirstAndLastMessage = buildICFALMessage(data);

        var options = {
            url: config.url + '/v1/accounts/' + domainId + '/inquiryComponentFirstAndLast',
            method: 'POST',
            headers: {
                'x-iotkit-requestid': contextProvider.get('requestid'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(inquiryComponentFirstAndLastMessage)
        };
        logger.debug("data-proxy. getFirstAndLastMeasurement, options: " + JSON.stringify(options));

        request(options, function (err, res) {
            if (!err && res.statusCode === responses.Success.OK) {
                logger.debug("data-proxy. getFirstAndLastMeasurement, Got Response from AA API: " + JSON.stringify(res.body));
                callback(null, res.body);
            } else if(!err && res.statusCode === responses.Success.NoContent) {
                logger.warn("data-proxy. getFirstAndLastMeasurement, Got No-content Response from AA API: " + JSON.stringify(res.body));
                callback(null, { componentsFirstLast: [] });
            } else {
                var errMsg = responses.buildErrorMessage(err, res);
                logger.warn("data-proxy. getFirstAndLastMeasurement, error: " + errMsg);
                if (res) {
                    var error = {
                        statusCode: res.statusCode,
                        body: res.body
                    };
                    logger.warn("data-proxy. getFirstAndLastMeasurement, response: " + JSON.stringify(error));
                    if (error.statusCode === responses.Errors.BadRequest) {
                        return callback(error);
                    }
                }
                callback({message: 'error receiving data'});
            }
        });
    };
};
