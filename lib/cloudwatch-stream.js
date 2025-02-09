const os = require("os");
const util = require("util");
const async = require("async");
const {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DescribeLogStreamsCommand,
  PutLogEventsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const Writable = require("stream").Writable;

function CloudWatchStream(options) {
  if (!(this instanceof CloudWatchStream)) {
    return new CloudWatchStream(options);
  }

  if (!options.group) {
    throw new Error("options.group is required.");
  }

  options.objectMode = true;

  this.logStreamNamePrefix = options.prefix;
  this.logGroupName = options.group;
  this.logStreamName =
    options.stream ||
    (options.prefix ? options.prefix + "-" : "") + os.hostname() + "-" + process.pid + "-" + new Date().getTime();
  this.nextSequenceToken = null;

  let awsOptions = {};

  if (options.aws_region || options.aws_access_key_id || options.aws_secret_access_key) {
    awsOptions = {
      credentials: {
        accessKeyId: options.aws_access_key_id,
        secretAccessKey: options.aws_secret_access_key,
      },
      region: options.aws_region,
    };
  }

  this.cloudWatchLogs = new CloudWatchLogsClient(awsOptions);

  Writable.call(this, options);
}

util.inherits(CloudWatchStream, Writable);

CloudWatchStream.prototype.createLogGroup = function (options, callback) {
  if (options.nextSequenceToken) {
    return callback(null, options);
  }

  this.cloudWatchLogs.send(
    new CreateLogGroupCommand({
      logGroupName: options.logGroupName,
    }),
    function (err /*, data*/) {
      if (err && err.name === "ResourceAlreadyExistsException") {
        err = null;
      }
      callback(err, options);
    }
  );
};

CloudWatchStream.prototype.createLogStream = function (options, callback) {
  if (options.nextSequenceToken) {
    return callback(null, options);
  }

  this.cloudWatchLogs.send(
    new CreateLogStreamCommand({
      logGroupName: options.logGroupName,
      logStreamName: options.logStreamName,
    }),
    function (err /*, data*/) {
      if (err && err.name === "ResourceAlreadyExistsException") {
        err = null;
      }
      callback(err, options);
    }
  );
};

CloudWatchStream.prototype.nextToken = function (options, callback) {
  if (options.nextSequenceToken) {
    return callback(null, options);
  }

  this.cloudWatchLogs.send(
    new DescribeLogStreamsCommand({
      logGroupName: options.logGroupName,
      logStreamNamePrefix: options.logStreamName,
    }),
    function (err, data) {
      if (err) {
        return callback(err);
      }

      if (!data || !data.logStreams || data.logStreams.length === 0) {
        return callback(new Error("LogStream not found."));
      }

      options.nextSequenceToken = data.logStreams[0].uploadSequenceToken;
      callback(err, options);
    }
  );
};

CloudWatchStream.prototype.putLogEvents = function (options, callback) {
  const self = this;

  this.cloudWatchLogs.send(
    new PutLogEventsCommand({
      logEvents: options.logEvents,
      logGroupName: options.logGroupName,
      logStreamName: options.logStreamName,
      sequenceToken: options.nextSequenceToken,
    }),
    function (err, data) {
      if (err && err.name === "InvalidSequenceTokenException") {
        const body = JSON.parse(this.httpResponse.body.toString());
        options.nextSequenceToken = body.expectedSequenceToken;

        return self.putLogEvents(options, callback);
      }

      options.nextSequenceToken = data && data.nextSequenceToken;
      callback(err, options);
    }
  );
};

CloudWatchStream.prototype._write = function (chunks, encoding, callback) {
  if (!Array.isArray(chunks)) {
    chunks = [chunks];
  }

  const complete = function (err, options) {
    if (err) {
      return callback(err);
    }

    this.nextSequenceToken = options.nextSequenceToken;
    this.emit("flushed");

    return callback();
  };

  const options = {
    logGroupName: this.logGroupName,
    logStreamName: this.logStreamName,
    nextSequenceToken: this.nextSequenceToken,
    logEvents: chunks.map(function (c) {
      return {
        timestamp: new Date().getTime(),
        message: c.toString(),
      };
    }),
  };

  async.waterfall(
    [
      this.createLogGroup.bind(this, options),
      this.createLogStream.bind(this),
      this.nextToken.bind(this),
      this.putLogEvents.bind(this),
    ],
    complete.bind(this)
  );
};

module.exports = CloudWatchStream;
