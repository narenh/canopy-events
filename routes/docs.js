// The API's documentation. openapi.yaml in the repo is the contract (the
// tests hold the server to it), served as is at /api/v1/openapi.yaml for
// tools and app developers, and rendered for people at /docs.
//
// The renderer is Redoc's standalone bundle, copied from npm into
// public/vendor/redoc-2.5.4/ (MIT; its LICENSE and the bundle's own notices
// sit next to it). It's served from here, never from a CDN: the docs page
// shouldn't depend on, or tell, anyone else. The version is in the path,
// so a new version is a new URL and no cache can mix the two up.

const express = require('express');
const path = require('path');

const SPEC_FILE = path.join(__dirname, '..', 'openapi.yaml');
const REDOC = '/vendor/redoc-2.5.4/redoc.standalone.js';

const DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canopy Events API</title>
<style>body { margin: 0; }</style>
</head>
<body>
<div id="redoc"></div>
<script src="${REDOC}"></script>
<script>
  Redoc.init('/api/v1/openapi.yaml', {
    hideDownloadButton: false,
    expandResponses: '200,201',
    theme: { colors: { primary: { main: '#0A3800' } } }
  }, document.getElementById('redoc'));
</script>
</body>
</html>
`;

module.exports = function docsRoutes() {
  const router = express.Router();

  router.get('/api/v1/openapi.yaml', (req, res) => {
    res.set('Content-Type', 'application/yaml; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(SPEC_FILE);
  });

  router.get('/docs', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(DOCS_PAGE);
  });

  return router;
};
