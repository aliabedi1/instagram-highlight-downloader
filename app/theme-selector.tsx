"use client";

import { useSyncExternalStore } from "react";

const THEME_KEY = "keepsake-color-theme";

type Theme = "light" | "system" | "dark";

const themeListeners = new Set<() => void>();

function getTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const savedTheme = window.localStorage.getItem(THEME_KEY);
  return savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system";
}

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function setColorTheme(nextTheme: Theme) {
  if (nextTheme === "system") {
    window.localStorage.removeItem(THEME_KEY);
    delete document.documentElement.dataset.theme;
  } else {
    window.localStorage.setItem(THEME_KEY, nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }
  themeListeners.forEach((listener) => listener());
}

const themes: Array<{ label: string; value: Theme; icon: React.ReactNode }> = [
  {
    label: "Light",
    value: "light",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
      </svg>
    ),
  },
  {
    label: "System",
    value: "system",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4.5" width="18" height="13" rx="2" />
        <path d="M9 21h6M12 17.5V21" />
      </svg>
    ),
  },
  {
    label: "Dark",
    value: "dark",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />
      </svg>
    ),
  },
];

export default function ThemeSelector() {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, () => "system");

  return (
    <div className="theme-selector" role="group" aria-label="Color theme">
      {themes.map((option) => (
        <button
          type="button"
          key={option.value}
          className={theme === option.value ? "active" : ""}
          aria-label={`${option.label} theme`}
          aria-pressed={theme === option.value}
          title={`${option.label} theme`}
          onClick={() => setColorTheme(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
