const through = require('through2');
const path = require('path');
const gulp = require('gulp');
const ssr = require('../ssr');

const gulpMavoSSR = (base, options) => {
	if (!options) options = {};

	if (!options.suffix) options.suffix = '.tpl.html';

	// base = path.resolve(base); // make absolute path

	const staticPortPromise = ssr.makeStaticAppAndGetPort(base);

	return through.obj(async (file, encoding, callback) => {
		const staticPort = await staticPortPromise;
		const localServer = `http://localhost:${staticPort}/`;
		let newFile = file.clone();
		if (file.path.endsWith(options.suffix)) {
			newFile.path = file.path.slice(0, file.path.length - options.suffix.length) + '.html';
			const relBasePath = path.relative(base, file.path);
			const url = localServer + relBasePath;
			const {content} = await ssr.render(url);
			newFile.contents = new Buffer(content);
		}
		callback(null, newFile);
	});
};

exports.default = () => {
	return gulp.src('src/**').pipe(gulpMavoSSR('src')).pipe(gulp.dest('build'));
};
