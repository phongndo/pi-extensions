/** Strip control, bidi, and line-separator characters from display labels. */
export const safeLabel = (text: string): string => text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "");
