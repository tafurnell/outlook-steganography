/* eslint-disable */
// Build-time settings:
//   ADDIN_BASE_URL  – where the files are served from (manifest URLs).
//                     dev default: https://localhost:3000/
//                     prod default: https://itmsolutions.co.uk/outlook-stego/
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

const DEV_URL = "https://localhost:3000/";
const PROD_URL = "https://itmsolutions.co.uk/outlook-stego/";

module.exports = async (env, argv) => {
  const dev = argv.mode !== "production";
  let base = process.env.ADDIN_BASE_URL || (dev ? DEV_URL : PROD_URL);
  if (!base.endsWith("/")) base += "/";
  const origin = new URL(base).origin;

  const config = {
    devtool: dev ? "source-map" : false,
    entry: {
      taskpane: "./src/taskpane/taskpane.ts",
      commands: "./src/commands/commands.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].[contenthash:8].js",
      assetModuleFilename: "assets/[name].[contenthash:8][ext]",
      publicPath: base,
      clean: true,
    },
    resolve: { extensions: [".ts", ".js"] },
    module: {
      rules: [
        { test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ },
        { test: /\.wasm$/, type: "asset/resource" },
        { test: /\.css$/, type: "asset/resource" },
      ],
    },
    performance: { maxAssetSize: 1_000_000, maxEntrypointSize: 1_000_000 },
    plugins: [
      new HtmlWebpackPlugin({ filename: "taskpane.html", template: "./src/taskpane/taskpane.html", chunks: ["taskpane"] }),
      new HtmlWebpackPlugin({ filename: "commands.html", template: "./src/commands/commands.html", chunks: ["commands"] }),
      new CopyWebpackPlugin({
        patterns: [
          { from: "assets/icon-*.png", to: "assets/[name][ext]" },
          { from: "src/taskpane/taskpane.css", to: "taskpane.css" },
          {
            from: "manifest.template.xml",
            to: "manifest.xml",
            transform: (content) =>
              content.toString().replace(/\{\{BASE_URL\}\}/g, base).replace(/\{\{ORIGIN\}\}/g, origin),
          },
        ],
      }),
    ],
  };

  if (dev) {
    const devCerts = require("office-addin-dev-certs");
    config.devServer = {
      port: 3000,
      headers: { "Access-Control-Allow-Origin": "*" },
      server: { type: "https", options: await devCerts.getHttpsServerOptions() },
      static: false,
    };
  }
  return config;
};
