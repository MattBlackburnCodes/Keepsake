import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Keepsake — Remember the people who matter",
    short_name: "Keepsake",
    description: "A private place for the stories, details, and memories that make your people special.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbf7f1",
    theme_color: "#fbf7f1",
    orientation: "any",
    categories: ["lifestyle", "utilities"],
    icons: [
      {
        src: "/keepsake-favicon.png",
        sizes: "1024x1024",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/keepsake-favicon.png",
        sizes: "1024x1024",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
