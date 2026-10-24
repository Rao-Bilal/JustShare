/**
 * JustShare Mobile Design System & Theme Tokens.
 * Light, soft palette with rounded cards and blue accent.
 */
export const theme = {
  colors: {
    // Backgrounds
    background: '#f8fafc', // Soft light slate
    surface: '#ffffff', // Card surface
    surfaceAlt: '#f1f5f9', // Light gray container
    surfaceMuted: '#e2e8f0', // Border & divider

    // Brand & Accents
    primary: '#2563eb', // Vibrant royal blue
    primaryLight: '#eff6ff', // Light blue tint
    primaryDark: '#1d4ed8', // Darker blue pressed
    accentGreen: '#16a34a', // Success badge
    accentGreenLight: '#dcfce7', // Success tint
    accentRed: '#dc2626', // Danger / decline
    accentRedLight: '#fee2e2', // Danger tint
    accentAmber: '#d97706', // Warning / waiting
    accentAmberLight: '#fef3c7',

    // Typography
    textPrimary: '#0f172a', // Deep slate heading/body
    textSecondary: '#475569', // Muted subtitle
    textTertiary: '#94a3b8', // Subtle placeholder / captions
    textInverse: '#ffffff', // White on blue/green

    // Status & borders
    border: '#e2e8f0',
    borderFocus: '#3b82f6',
    borderDashed: '#cbd5e1',
    divider: '#f1f5f9',
    overlay: 'rgba(15, 23, 42, 0.4)',
  },

  radii: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    full: 9999,
  },

  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
  },

  typography: {
    titleLarge: {
      fontSize: 24,
      fontWeight: '700' as const,
      lineHeight: 30,
    },
    titleMedium: {
      fontSize: 18,
      fontWeight: '700' as const,
      lineHeight: 24,
    },
    titleSmall: {
      fontSize: 16,
      fontWeight: '600' as const,
      lineHeight: 22,
    },
    bodyLarge: {
      fontSize: 15,
      fontWeight: '500' as const,
      lineHeight: 20,
    },
    bodyMedium: {
      fontSize: 14,
      fontWeight: '400' as const,
      lineHeight: 20,
    },
    bodySmall: {
      fontSize: 12,
      fontWeight: '400' as const,
      lineHeight: 16,
    },
    labelMedium: {
      fontSize: 13,
      fontWeight: '600' as const,
      lineHeight: 18,
    },
    labelSmall: {
      fontSize: 11,
      fontWeight: '600' as const,
      lineHeight: 14,
    },
    codeLarge: {
      fontSize: 32,
      fontWeight: '800' as const,
      letterSpacing: 4,
    },
  },

  shadows: {
    card: {
      shadowColor: '#0f172a',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 8,
      elevation: 2,
    },
    sheet: {
      shadowColor: '#0f172a',
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.1,
      shadowRadius: 16,
      elevation: 8,
    },
  },
};

export type Theme = typeof theme;
