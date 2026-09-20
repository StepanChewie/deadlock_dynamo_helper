const path = require('path');
const webpack = require('webpack');
const { version } = require('./package.json');

module.exports = {
  entry: {
    index: './src/index.ts',
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'public/dist'),
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    new webpack.DefinePlugin({
      __APP_VERSION__: JSON.stringify(version),
    }),
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
};
