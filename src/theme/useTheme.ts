import { useContext } from "react";
import { ThemeCtx, type ThemeContextValue } from "./themeContext";

/** Retrieves the current theme context from ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
