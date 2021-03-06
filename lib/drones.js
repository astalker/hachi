/*
 The MIT License

 Copyright (c) 2013 Hadrien Jouet https://github.com/grownseed

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 */

var nconf = require('nconf'),
  fs = require('fs'),
  fstreamnpm = require('fstream-npm'),
  tar = require('tar'),
  zlib = require('zlib');

var drones = module.exports;

drones._getDomains = function(pkg) {
  var domains = [];

  ['domain', 'domains', 'subdomain', 'subdomains'].forEach(function(key) {
    if (pkg[key]) {
      if (typeof pkg[key] === 'string')
        pkg[key] = pkg[key].split(' ');

      pkg[key].forEach(function(domain) {
        if (domain)
          domains.push(domain);
      });
    }
  });

  return domains;
};

drones.listdrones = function(options, fn) {
  var self = this,
    path = 'drones';

  this.parent.populate(options, ['user', 'app'], function(err, options) {
    if (err)
      return fn(err);

    if (options.user && options.user.trim() != '') {
      path += '/' + options.user;

      if (options.app && options.app.trim() != '')
        path += '/' + options.app;
    }

    self.parent.request(path, function(err, result) {
      if (err)
        return fn(err);

      var msg = [['User', 'Name', 'Internal Address', 'Domains', 'Started']];

      if (result && result.drones && result.drones.push) {
        result.drones.forEach(function(d) {
          var domains = self._getDomains(d);

          msg.push([
            d.user,
            d.name,
            d.host + ':' + (d.env && d.env.PORT || '#'),
            domains.join('\n'),
            (d.started ? 'yes' : 'no')
          ]);
        });
      }

      fn(null, {raw: result, message: msg});
    });
  });

};

drones._validatePackage = function(options) {
  var path = options.dir || process.cwd(),
    errors = {};

  try {
    nconf.file(path + '/package.json');
  }
  catch (e) {
    return {errors: false};
  }

  //merge any options if passed
  ['user', 'name', 'scripts.start', 'engines.node', 'domains'].forEach(function(k) {
    if (options[k] != undefined)
      nconf.set(k.replace('.', ':'), options[k]);
  });

  //save new package
  nconf.save();

  //check user
  if (!nconf.get('user') || typeof nconf.get('user') !== 'string')
    errors['user'] = 'Unspecified or incorrect user';

  //check app name, only allow letters and numbers
  if (!nconf.get('name') || typeof nconf.get('name') !== 'string' ||
      nconf.get('name') && !nconf.get('name').match(/^[a-z0-9]+$/i))
    errors['name'] = 'Name has to provided and it can only be letters and numbers';

  //check for start script
  if (!nconf.get('scripts:start') || typeof nconf.get('scripts:start') !== 'string' || nconf.get('scripts:start') &&
      !fs.existsSync(path + '/' + nconf.get('scripts:start')))
    errors['scripts.start'] = 'Unspecified or missing start script';

  //check for node engine
  if (!nconf.get('engines:node') || typeof nconf.get('engines:node') !== 'string')
    errors['engines.node'] = 'Unspecified or incorrect node engine';

  //check for domains
  if (this._getDomains(nconf.get()).length === 0)
    errors['domains'] = 'At least one domain has to be specified';

  return {errors: errors, pkg: nconf.get()};
};

drones.deploy = function(options, fn) {
  var self = this;

  //use default host user if not specified
  options.user = options.user || this.parent.host.user;

  //validate package.json and update it if required
  var result = this._validatePackage(options);

  if (result.errors === false)
    return fn({message: 'Error parsing package.json'});

  var error_fields = Object.keys(result.errors);

  if (error_fields.length > 0) {
    var required = [],
      msg = [];

    for (var k in result.errors) {
      required.push(k);
      msg.push(result.errors[k]);
    }

    return fn({required: required, message: msg.join('\n')});
  }

  //create archive
  options.data = fstreamnpm({path: options.dir || process.cwd()})
    .on('error', fn)
    .pipe(tar.Pack())
    .on('error', fn)
    .pipe(zlib.Gzip())
    .on('error', fn);

  options.app = options.app || result.pkg && result.pkg.name || '';

  this.parent.request('drones/' + options.user + '/' + options.app + '/deploy', 'post', options, function(err, drone) {
    if (err)
      return fn(err);

    fn(null, {raw: drone, message: 'Deployment complete:\n' + self._getDomains(result.pkg).join('\n')});
  });
};

drones._changeState = function(options, fn, state) {
  var self = this;

  options.dir = options.dir || process.cwd();

  //look for local package.json
  nconf.file(options.dir + '/package.json');

  options.user = nconf.get('user') || options.user || this.parent.host.user;
  options.app = nconf.get('name') || options.app;

  this.parent.populate(options, ['user', 'app'], function(err, options) {
    if (err)
      return fn(err);

    self.parent.request('drones/' + options.user + '/' + options.app + '/' + state, 'post', function(err, result) {
      if (err)
        return fn(err);

      fn(null, {raw: result, message: 'App successfully ' + state + 'ed:\n' + self._getDomains(result).join('\n')});
    });
  });
};

drones.start = function(options, fn) {
  this._changeState(options, fn, 'start');
};

drones.stop = function(options, fn) {
  this._changeState(options, fn, 'stop');
};

drones.restart = function(options, fn) {
  this._changeState(options, fn, 'restart');
};

drones.logs = function(options, fn) {
  var self = this;

  this.parent.populate(options, ['user', 'app'], function(err, options) {
    if (err)
      return fn(err);

    var path = 'drones/' + options.user + '/' + options.app + '/logs';

    self.parent.request(path, function(err, result) {
      if (err)
        return fn(err);

      var msg = [['Time', 'Message', 'Type']];

      if (result && result.push && result.length > 0) {
        result.forEach(function(l) {
          msg.push([l.ts, l.msg, l.type]);
        });
      }

      fn(null, {raw: result, message: msg});
    });
  });
};