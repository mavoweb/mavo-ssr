mavo-ssr
--------

Server-side rendering/prerendering for [Mavo](https://mavo.io/) apps, using Google's [puppeteer](https://developers.google.com/web/tools/puppeteer/), following their [SSR guide](https://developers.google.com/web/tools/puppeteer/articles/ssr), which also motivates why we want to do server-side rendering quite well.

In brief: typical Mavo apps are served with no content; the content is rendered entirely in JavaScript in the client's browser. This may prevent search engines from indexing Mavo apps, or users with slower browsers from viewing the app. Server-side rendering does exactly what it sounds like; initial rendering happens on the server, before search engines and users see it, so that the initial content will be visible to them. The Mavo app will still be interactive (after roughly the same amount of time loading in the browsers, and assuming this doesn't have any bugs).

Usage
-----

Install [Node](https://nodejs.org/) at least version 8 to use. Then, if your Mavo site is in the folder `/path/to/your/site`, you can run the simplest server like this:

```
$ node server.js serve /path/to/your/site
```

Then visit the SSR server that's printed in your browser. This server will render every page in headless Chrome before serving it.

You can pass in a directory where the server will cache rendered versions of any requested pages in with the option `--cache`. Other settings are described if you run `node server.js` or `node server.js serve --help`.
