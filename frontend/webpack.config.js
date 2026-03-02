//@ts-check
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
module.exports = {
  target:  'node',
  mode:    'none',

  entry:   './src/extension.ts',
  output:  {
    path:           path.resolve(__dirname, 'out'),
    filename:       'extension.js',
    libraryTarget:  'commonjs2',
  },

  externals: { vscode: 'commonjs vscode' },

  resolve: { extensions: ['.ts', '.js'] },

  module: {
    rules: [{
      test:    /\.ts$/,
      use:     [{ loader: 'ts-loader' }],
      exclude: /node_modules/,
    }],
  },

  devtool:                 'nosources-source-map',
  infrastructureLogging:  { level: 'log' },
};
