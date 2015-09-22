var walkSync = require('walk-sync');
var Writer = require('broccoli-writer');
var UglifyJS = require('uglify-js');
var path = require('path');
var fs = require('fs');
var merge = require('lodash-node/modern/objects/merge');
var symlinkOrCopy = require('symlink-or-copy');
var mkdirp = require('mkdirp');
var srcURL = require('source-map-url');
var MatcherCollection = require('matcher-collection');
var debug = require('debug')('broccoli-uglify-sourcemap');

module.exports = UglifyWriter;

UglifyWriter.prototype = Object.create(Writer.prototype);
UglifyWriter.prototype.constructor = UglifyWriter;

function UglifyWriter (inputTree, options) {
  if (!(this instanceof UglifyWriter)) {
    return new UglifyWriter(inputTree, options);
  }
  Writer.call(this, inputTree, options);
  this.options = merge({
    mangle: true,
    compress: true,
    sourceMapIncludeSources: true
  }, options);

  this.sourceMapConfig = merge({
    enabled: true,
    extensions: ['js']
  }, this.options.sourceMapConfig);

  this.inputTree = inputTree;

  var exclude = this.options.exclude;
  if (Array.isArray(exclude)) {
    this.excludes = new MatcherCollection(exclude);
  } else {
    this.excludes = MatchNothing;
  }
}

var MatchNothing = {
  match: function () {
    return false;
  }
};

UglifyWriter.prototype.write = function (readTree, outDir) {
  var writer = this;
  return readTree(this.inputTree).then(function(inDir){
    walkSync(inDir).forEach(function(relativePath) {
      if (relativePath.slice(-1) === '/') {
        return;
      }
      var inFile = path.join(inDir, relativePath);
      var outFile = path.join(outDir, relativePath);

      mkdirp.sync(path.dirname(outFile));

      if (relativePath.slice(-3) === '.js' && !writer.excludes.match(relativePath)) {
        writer.processFile(inFile, outFile, relativePath, outDir);
      } else if (relativePath.slice(-4) === '.map') {
        if (writer.excludes.match(relativePath.slice(relativePath.lenth - 4) + '.js')) {
          // ensure .map files for excldue JS paths are also copied forward
          symlinkOrCopy.sync(inFile, outFile);
        }
        // skip, because it will get handled when its corresponding JS does
      } else {
        symlinkOrCopy.sync(inFile, outFile);
      }
    });
    return outDir;
  });
};

UglifyWriter.prototype.enableSourcemaps = function() {
  return this.sourceMapConfig.enabled &&
    this.sourceMapConfig.extensions.indexOf('js') > -1;
};


UglifyWriter.prototype.mapURL = function(mapName) {
  if (this.enableSourcemaps()) {
    if (this.sourceMapConfig.mapDir) {
      return '/' + path.join(this.sourceMapConfig.mapDir, mapName);
    } else {
      return mapName;
    }
  }
};

UglifyWriter.prototype.processFile = function(inFile, outFile, relativePath, outDir) {
  var src = fs.readFileSync(inFile, 'utf-8');
  var mapName = path.basename(outFile).replace(/\.js$/,'') + '.map';
  var mapDir;
  var origSourcesContent;

  if (this.sourceMapConfig.mapDir) {
    mapDir = path.join(outDir, this.sourceMapConfig.mapDir);
  } else {
    mapDir = path.dirname(path.join(outDir, relativePath));
  }

  var opts = {
    fromString: true,
    outSourceMap: this.mapURL(mapName),
    enableSourcemaps: this.enableSourcemaps()
  };

  if (opts.enableSourcemaps && srcURL.existsIn(src)) {
    var url = srcURL.getFrom(src);
    opts.inSourceMap = path.join(path.dirname(inFile), url);
    origSourcesContent = JSON.parse(fs.readFileSync(opts.inSourceMap)).sourcesContent;
  }

  try {
    var start = new Date();
    debug('[starting]: %s %dKB', relativePath, (src.length / 1000));
    var result = UglifyJS.minify(src, merge(opts, this.options));
    var end = new Date();
    var total = end - start;
    debug('[finsihed]: %s %dKB in %dms', relativePath, (result.code.length / 1000), total);

    if (total > 20000) {
      console.warn(
        '[WARN] `' + relativePath + '` took: ' + total + 'ms (more then 20,000ms). ' +
        'This is likely due to the total amount of code that is being minified. You may be ' +
        'including more than you intended, or re-minifying vendor code that has already been ' +
        'processed. If you know of files that don\'t need to be minified you can exclude them with' +
        'the `exclusion` option. See: https://github.com/ef4/broccoli-uglify-sourcemap#usage'
      );
    }


  } catch(e) {
    e.filename = relativePath;
    throw e;
  }

  if (opts.enableSourcemaps) {
    var newSourceMap = JSON.parse(result.map);

    if (origSourcesContent) {
      // This is a workaround for https://github.com/mishoo/UglifyJS2/pull/566
      newSourceMap.sourcesContent = origSourcesContent;
    } else {
      newSourceMap.sources = [ relativePath ];
      newSourceMap.sourcesContent = [ src ];
    }

    // uglify is wrong about this and always puts the maps own name
    // here.
    newSourceMap.file = path.basename(inFile);

    newSourceMap.sources = newSourceMap.sources.map(function(path){
      // If out output file has the same name as one of our original
      // sources, they will shadow eachother in Dev Tools. So instead we
      // alter the reference to the upstream file.
      if (path === relativePath) {
        path = path.replace(/\.js$/, '-orig.js');
      }
      return path;
    });
    mkdirp.sync(mapDir);
    fs.writeFileSync(path.join(mapDir, mapName), JSON.stringify(newSourceMap));
  }
  fs.writeFileSync(outFile, result.code);
};
