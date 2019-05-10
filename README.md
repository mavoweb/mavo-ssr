mavo-ssr
--------

Server-side rendering/prerendering for [Mavo](https://mavo.io/) apps, using Google's [puppeteer](https://developers.google.com/web/tools/puppeteer/), following their [SSR guide](https://developers.google.com/web/tools/puppeteer/articles/ssr), which also motivates why we want to do server-side rendering quite well.

In brief: typical Mavo apps are served with no content; the content is rendered entirely in JavaScript in the client's browser. This may prevent search engines from indexing Mavo apps (although Google does successfully index many Mavo apps). It may also stop many sites' preview features from working on Mavo apps, or users with slower browsers from viewing the app. Server-side rendering does exactly what it sounds like; initial rendering happens on the server, before search engines and users see it, so that the initial content will be visible to them. The Mavo app will still be interactive (after roughly the same amount of time loading in the browsers, and assuming this doesn't have any bugs).

This implementation is still fairly experimental, but we hope it is useful!

Usage
-----

Install [Node](https://nodejs.org/) (at least version 8) and [npm](https://www.npmjs.com/). Run

```
$ npm install
```

to install dependencies. Then, if your Mavo site is in the folder `/path/to/your/site`, you can run the simplest server like this:

```
$ node server.js serve /path/to/your/site
```

Then visit the SSR server that's printed in your browser. This server will render every page in headless Chrome before serving it.

You can pass in a directory where the server will cache rendered versions of any requested pages in with the option `--cache`:

```
$ node server.js serve /path/to/your/site --cache mycache
```

Then, as requests come in, `mavo-ssr` will cache any responses it serves as plain HTML files in the `mycache` directory, and will serve files from the cache instead of rerendering them. (The cache is currently never invalidated, but we hope to add this feature some day.)

If you want, you can serve your website primarily through `mavo-ssr` just by running `server.js` as described above and specifying a port number with `--port`, although this is not recommended for production use since it's just running an extremely simple [express.js](https://expressjs.com/) server. You can also use `mavo-ssr` as a prerendering tool by serving with a cache, then just manually visiting each page in your site and statically serving the files that were output into the cache directory instead.

Other settings are described if you run `node server.js` or `node server.js serve --help`.
