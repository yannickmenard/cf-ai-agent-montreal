import { useEffect } from "react";
import type { Theme } from "./themeContext";

type FaviconPaths = {
  light: string;
  dark: string;
};

/** Keeps the <link id="app-favicon"> in sync with the current theme. */
export function useFavicon(theme: Theme, paths: FaviconPaths = {
  light: "/favicon-light.png",
  dark: "/favicon-dark.png",
}) {
  useEffect(() => {
    const ensureLink = (): HTMLLinkElement => {
      let link = document.querySelector<HTMLLinkElement>('link#app-favicon');
      if (!link) {
        link = document.createElement('link');
        link.id = 'app-favicon';
        link.rel = 'icon';
        link.type = 'image/png';
        document.head.appendChild(link);
      }
      return link;
    };

    const link = ensureLink();
    const mql = window.matchMedia("(prefers-color-scheme: dark)");

    const setHref = () => {
      const effectiveDark =
        theme === "dark" || (theme === "system" && mql.matches);
      link.href = effectiveDark ? paths.dark : paths.light;
    };

    setHref(); // initial
    if (theme === "system") {
      const handler = () => setHref();
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
  }, [theme, paths.dark, paths.light]);
}
