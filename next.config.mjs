// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // simple-peer (WebRTC) pulls in Node core modules + expects `process`/`Buffer`
  // globals that do not exist in the browser. Stub the modules and provide the
  // globals so the client bundle builds cleanly. `webpack` is provided by Next
  // via the second callback argument — never import it directly.
  webpack: (config, { webpack }) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.plugins.push(
      new webpack.ProvidePlugin({
        process: 'process/browser',
        Buffer: ['buffer', 'Buffer'],
      }),
    );
    return config;
  },
};

export default nextConfig;
