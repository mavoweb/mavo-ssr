const through = require('through2');
const path = require('path');
const gulp = require('gulp');
const ssr = require('../ssr');
const rename = require('gulp-rename');

const gulpMavoSSR = (base) => {
	const staticPortPromise = ssr.makeStaticAppAndGetPort(base);

	return through.obj(async (file, encoding, callback) => {
		const staticPort = await staticPortPromise;
		const relBasePath = path.relative(base, file.path);
		let newFile = file.clone();
		const url = `http://localhost:${staticPort}/${relBasePath}`;
		const {content} = await ssr.render(url);
		newFile.contents = new Buffer(content);
		callback(null, newFile);
	});
};

exports.default = () => {
	return gulp.src('**/*.tpl.html')
		.pipe(gulpMavoSSR('.'))
		.pipe(rename({ extname: '' }))
		.pipe(rename({ extname: '.html' }))
		.pipe(gulp.dest('.'));
};
