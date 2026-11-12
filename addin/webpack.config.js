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
// Separate add-in IDs so the dev (localhost) and production add-ins can be installed side by side.
// Note: Outlook keeps roaming settings per add-in ID, so each needs the passphrase entered once.
const DEV_ID = "fe2ac711-2b65-481d-82aa-71296a26a12a";

// Event-based activation (D-039/D-041): on by default; ENABLE_EVENTS=0 builds without it.
const RUNTIMES_XML = `
          <!-- Event-based activation: browser runtime (new Outlook / web); JS-only override for classic Windows -->
          <Runtimes>
            <Runtime resid="WebViewRuntime.Url">
              <Override type="javascript" resid="JSRuntime.Url"/>
            </Runtime>
          </Runtimes>`;
const LAUNCH_EVENT_XML = `

            <!-- New email / reply / forward: offer "Add secure signature" without opening the pane -->
            <ExtensionPoint xsi:type="LaunchEvent">
              <LaunchEvents>
                <LaunchEvent Type="OnNewMessageCompose" FunctionName="onNewMessageComposeHandler"/>
              </LaunchEvents>
              <SourceLocation resid="WebViewRuntime.Url"/>
            </ExtensionPoint>`;
const PROD_ID = "70da7104-a4f3-49c8-bbcd-67c9b8f4a5cc";

module.exports = async (env, argv) => {
  const dev = argv.mode !== "production";
  let base = process.env.ADDIN_BASE_URL || (dev ? DEV_URL : PROD_URL);
  if (!base.endsWith("/")) base += "/";
  const origin = new URL(base).origin;
  const events = process.env.ENABLE_EVENTS !== "0";

  const config = {
    devtool: dev ? "source-map" : false,
    entry: {
      taskpane: "./src/taskpane/taskpane.ts",
      commands: "./src/commands/commands.ts",
      // Stable (unhashed) name: the manifest's JS-only runtime override must point at a fixed URL.
      launchevent: "./src/launchevent/launchevent.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: (pathData) => (pathData.chunk.name === "launchevent" ? "[name].js" : "[name].[contenthash:8].js"),
      chunkFilename: "[name].[contenthash:8].js", // e.g. the KDF Web Worker – hashed, so nginx can cache it long-term
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
              content
                .toString()
                .replace(/\{\{BASE_URL\}\}/g, base)
                .replace(/\{\{ORIGIN\}\}/g, origin)
                .replace(/\{\{ADDIN_ID\}\}/g, dev ? DEV_ID : PROD_ID)
                .replace(/\{\{DISPLAY_NAME\}\}/g, dev ? "Secure Signature (dev)" : "Secure Signature")
                .replace(/\{\{RUNTIMES\}\}/g, events ? RUNTIMES_XML : "")
                .replace(/\{\{LAUNCH_EVENT\}\}/g, events ? LAUNCH_EVENT_XML : "")
                // OnNewMessageCompose and notification actions need Mailbox 1.10.
                .replace(/\{\{MIN_MAILBOX\}\}/g, events ? "1.10" : "1.8"),
          },
        ],
      }),
    ],
  };

  if (dev) {
    const devCerts = require("office-addin-dev-certs");
    config.devServer = {
      port: 3000,
      // no-store: stop Outlook's embedded browser serving stale dev builds
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      server: { type: "https", options: await devCerts.getHttpsServerOptions() },
      static: false,
    };
  }
  return config;
};
