import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["mapbox-gl", "@mapbox/mapbox-gl-draw"],
};

export default nextConfig;
