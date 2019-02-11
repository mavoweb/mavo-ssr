// https://developers.google.com/web/tools/puppeteer/articles/ssr
//
// await $.ready();
// await Mavo.inited;
// await Promise.all(Array.from(Mavo.all).map(mavo => mavo.dataLoaded)) // but this fails if any one promise fails
// await Promise.all(Array.from(Mavo.all).map(mavo => mavo.dataLoaded.catch(e => e)))

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
// assumes something locally serving files from the above address for
// puppeteer's headless chrome to view;
// python -m SimpleHTTPServer 8002 works fine
//
// finish loading event: investigate mv-load event

async function ssr(url) {
	const start = Date.now();
	// const browser = await puppeteer.launch({headless: false});
	const browser = await puppeteer.launch({headless: true});
	const page = await browser.newPage();

	// 1. Intercept network requests.
	// await page.setRequestInterception(true);

	// page.on('request', req => {
	// 	// 2. Ignore requests for resources that don't produce DOM
	// 	// (images, stylesheets, media).
	// 	const whitelist = ['document', 'script', 'xhr', 'fetch'];
	// 	if (!whitelist.includes(req.resourceType())) {
	// 		return req.abort();
	// 	}

	// 	// 3. Pass through all other requests.
	// 	req.continue();
	// });

	// debugging
	page.on('console', msg => console.log('PAGE LOG:', msg.text()));
	page.on('error', msg => console.log('PAGE ERR:', msg.message));
	page.on('pageerror', msg => console.log('PAGE ERR:', msg.message));

	// https://github.com/GoogleChrome/puppeteer/blob/master/examples/custom-event.js
	const html = await new Promise(async (resolve) => {
		let neededLoads = 1; // ugh
		let innerResolve;
		let resultPromise = new Promise(resolve => { innerResolve = resolve });
		await page.exposeFunction('onMvLoad', async () => {
			neededLoads--;
			if (neededLoads === 0) {
				const html = await page.content(); // serialized HTML of page DOM.
				console.log('content obtained');
				innerResolve(html);
			}
		});
		console.log('done exposing');
		await page.evaluateOnNewDocument(() => {
			document.addEventListener("mv-load", async (event) => {
				await Bliss.ready();
				await Mavo.inited;
				await Promise.all(Array.from(Mavo.all).map(mavo => mavo.dataLoaded.catch(e => e)));
				let dirty = true;
				["domexpression-update-start", "domexpression-update-end", "node-render-start", "node-render-end"].forEach(hookName => {
					Mavo.hooks.add(hookName, () => {
						// console.log(`${hookName} fired, counting as dirty`);
						dirty = true;
					});
				});
				const checkDirty = () => {
					if (dirty) {
						console.log('check: still dirty');
						dirty = false;
						window.setTimeout(checkDirty, 500);
					} else {
						console.log('mv-load in browser');
						window.onMvLoad();
					}
				};
				window.setTimeout(checkDirty, 500);
			});
		});
		console.log('done evaluating to add listener');
		try {
			await page.goto(url, {waitUntil: 'networkidle0'});
			console.log('done goto');
			const result = await resultPromise;
			console.log('done resolving resultPromise; let us resolve result!');
			resolve(result);
		} catch (e) {
			console.log('goto failed');
			console.log(e);
		}
	});
	await browser.close();

	const ttRenderMs = Date.now() - start;
	console.info(`Headless rendered page in: ${ttRenderMs}ms`);

	return {html, ttRenderMs};
}

if (process.argv.length >= 4 && process.argv[2] === "server") {
	const app = express();
	const port = process.argv[3];

	const localServer = `http://localhost:${port}/`;
	app.get('/:page.html', async (req, res, next) => {
		const {html, ttRenderMs} = await ssr(`${localServer}${req.params.page}.html`);
		// Add Server-Timing! See https://w3c.github.io/server-timing/.
		res.set('Server-Timing', `Prerender;dur=${ttRenderMs};desc="Headless render time (ms)"`);
		return res.status(200).send(html); // Serve prerendered page as response.
	});
	app.get('/restaurants/', async (req, res, next) => {
		const {html, ttRenderMs} = await ssr(`${localServer}restaurants/`);
		// Add Server-Timing! See https://w3c.github.io/server-timing/.
		res.set('Server-Timing', `Prerender;dur=${ttRenderMs};desc="Headless render time (ms)"`);
		return res.status(200).send(html); // Serve prerendered page as response.
	});
	app.use(express.static('dist'));
	// app.use('/dist', express.static('dist'));

	app.listen(8080, () => console.log('Server started. Press Ctrl+C to quit'));
} else if (process.argv.length >= 5 && process.argv[2] === "prerender") {
	const port = process.argv[3];
	const path = process.argv[4];
	const localServer = `http://localhost:${port}/`;
	(async() => {
		const {html, ttRenderMs} = await ssr(`${localServer}${path}`);
		await new Promise((resolve, reject) => {
			const file = path.replace(/[^-_.a-zA-Z0-9]/g, "_");
			fs.writeFile(`./${file}`, html, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	})();
} else {
	console.log("node server.js server <port>");
	console.log("node server.js prerender <port> <page>");
}
