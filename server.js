// https://developers.google.com/web/tools/puppeteer/articles/ssr

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const httpProxy = require('http-proxy');

const makeListenToFreePort = (app, message, firstPort, doUnref) => {
	let ret = Promise.reject();
	for (let portOffset = 0; portOffset < 10; portOffset++) {
		const port = firstPort + portOffset;
		ret = ret.catch(() => new Promise((resolve, reject) => {
			const server = app.listen(port, () => {
				console.log(message + " listening on port " + port);
				resolve(port);
			});
			if (doUnref) {
				server.unref();
			}
			server.on('error', (e) => {
				console.log(e);
				reject(e);
			});
		}));
	}
	return ret;
};

const HEADLESS = true;

async function ssr(url) {
	const start = Date.now();
	const browser = await puppeteer.launch({headless: HEADLESS});
	const page = await browser.newPage();

	// 1. Intercept network requests.
	await page.setRequestInterception(true);

	page.on('request', req => {
		// 2. Ignore requests for resources that don't produce DOM
		// (images, stylesheets, media).
		const whitelist = ['document', 'script', 'xhr', 'fetch'];
		if (!whitelist.includes(req.resourceType())) {
			return req.abort();
		}

		// 3. Pass through all other requests.
		req.continue();
	});

	// debugging
	page.on('console', msg => console.log('PAGE LOG:', msg.text()));
	page.on('error', msg => console.log('PAGE ERR:', msg.message));
	page.on('pageerror', msg => console.log('PAGE ERR:', msg.message));

	// https://github.com/GoogleChrome/puppeteer/blob/master/examples/custom-event.js
	const html = await new Promise(async (resolve) => {
		let innerResolve;
		let resultPromise = new Promise(resolve => { innerResolve = resolve });
		await page.exposeFunction('onMvLoad', async () => {
			const html = await page.content(); // serialized HTML of page DOM.
			console.log('content obtained');
			innerResolve(html);
		});
		await page.evaluateOnNewDocument(() => {

			let rawNodes = {};
			document.addEventListener("DOMContentLoaded", event => {
				console.log("DOMContentLoaded");
				self.Mavo.hooks.add("init-start", mavo => {
					const clone = mavo.element.cloneNode(true /*deep*/);
					console.log("init-start hook");
					rawNodes[mavo.id] = clone;
				});
			});
			let mvLoaded = false;
			document.addEventListener("mv-load", async (event) => {
				if (mvLoaded) return;
				mvLoaded = true;

				await Bliss.ready();
				console.log(Mavo);
				await Mavo.inited;
				await Promise.all(Array.from(Mavo.all).map(mavo => mavo.dataLoaded.catch(e => e)));
				let dirty = true;
				["domexpression-update-start", "domexpression-update-end", "node-render-start", "node-render-end"].forEach(hookName => {
					Mavo.hooks.add(hookName, () => {
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
						for (let name in Mavo.all) {
							const element = Mavo.all[name].element;
							element.classList.add("mv-ssr-target");
							// don't prevent rehydration here by removing
							// mv-app attribute as that might mess with CSS
							// selectors
						}
						const templateElement = document.createElement("template");
						templateElement.id = "mv-ssr-template";
						for (let rawId in rawNodes) {
							const rawNode = rawNodes[rawId];
							rawNode.id = rawId;
							console.log("raw node received");
							console.log(rawNode);
							templateElement.content.appendChild(rawNode);
						}
						document.head.appendChild(templateElement);

						const clientStyleElement = document.createElement("style");
						clientStyleElement.textContent = `
[mv-progress].mv-ssr-target::after {
	left: 0;
	top: 0;
}
`;
						// document.head.appendChild(clientStyleElement);

						const clientScriptElement = document.createElement("script");
						clientScriptElement.text = `
Mavo.hooks.add("init-start", function (mavo) {
	console.log("client init-start hook");
	var ssrTemplate = document.getElementById("mv-ssr-template");
	if (ssrTemplate) {
		console.log("client swaparoo");
		var ssrRawNode = ssrTemplate.content.getElementById(mavo.id);
		if (ssrRawNode) {
			mavo.ssrTarget = mavo.element;
			mavo.element = ssrRawNode;

			console.log("ssr target");
			console.log(mavo.ssrTarget);
			console.log("ssr element");
			console.log(mavo.element);
		}
	}

	mavo.dataLoaded.then(function () {
		console.log("client dataLoaded");
		mavo.element.classList.add("mv-ssr-ok");
		mavo.ssrTarget.parentNode.replaceChild(mavo.element, mavo.ssrTarget);
	});
});
`;

						document.body.appendChild(clientScriptElement);

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

const makeStaticAppAndGetPort = (path) => {
	const staticApp = express();
	staticApp.use(express.static(path));
	return makeListenToFreePort(staticApp, "static server", 8000, true);
};

if (process.argv.length >= 4 && process.argv[2] === "server") {
	makeStaticAppAndGetPort(process.argv[3]).then((staticPort) => {
		const app = express();

		const localServer = `http://localhost:${staticPort}/`;
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
		const apiProxy = httpProxy.createProxyServer();
		app.all("/dist/*", function(req, res) {
			console.log('passing through to server: ' + req.path);
			apiProxy.web(req, res, {target: localServer});
		});
		app.all("/*.(css|jpg|png|svg)", function(req, res) {
			console.log('passing through to server: ' + req.path);
			apiProxy.web(req, res, {target: localServer});
		});

		makeListenToFreePort(app, "SSR server", 8080);
	});
} else if (process.argv.length >= 5 && process.argv[2] === "prerender") {
	makeStaticAppAndGetPort(process.argv[3]).then(async(staticPort) => {
		const localServer = `http://localhost:${staticPort}/`;
		const path = process.argv[4];
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
	});
} else {
	console.log("node server.js server <path to static root>");
	console.log("node server.js prerender <path to static root> <page>");
}

// we could make a server that prerenders as a service
