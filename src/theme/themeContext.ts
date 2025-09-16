import { createContext } from "react";

export type Theme = "light" | "dark" | "system";

export type ThemeContextValue = {
  theme: Theme;
  setTheme: (t: Theme) => void;
};

export const ThemeCtx = createContext<ThemeContextValue | null>(null);
