import { studioTheme } from 'ag-studio'

/**
 * Mandate's paper, ink and lime, applied to Studio: square corners, a hard ink border on every widget, the console's
 * own type. The chart palette is ink and lime first, so a refusal reads as ink and money kept reads as lime.
 */
export const mandateTheme = studioTheme.withParams({
  accentColor: '#050505',
  backgroundColor: '#fffcf5',
  foregroundColor: '#050505',
  borderColor: '#050505',
  borderWidth: 1.5,
  borderRadius: 0,
  fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
  fontSize: 14,
  studioCanvasBackgroundColor: '#f3efe6',
  studioCanvasFontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
  studioWidgetBackgroundColor: '#fffcf5',
  studioWidgetTitleFontSize: 13,
  studioWidgetTitleFontWeight: 700,
  studioWidgetTitleTextColor: '#5f5a50',
  studioCanvasRowHeight: 18,
  studioCanvasPadding: 10,
  // Room for the canvas beside the chat panel on a laptop screen.
  studioAiPanelWidth: 300,
  studioCanvasMinWidth: 520,
  studioWidgetBorder: '1.5px solid #050505',
  studioWidgetBorderRadius: 0,
  studioWrapperBorderRadius: 0,
  studioPanelContainerBorderRadius: 0,
  chartPaletteFills1Color: '#050505',
  chartPaletteFills2Color: '#e2ff41',
  chartPaletteFills3Color: '#5f5a50',
  chartPaletteFills4Color: '#cfc8b8',
  chartPaletteFills5Color: '#1b1a17',
  chartPaletteStrokes1Color: '#050505',
  chartPaletteStrokes2Color: '#050505',
  chartPaletteStrokes3Color: '#050505',
  chartPaletteStrokes4Color: '#050505',
  chartPaletteStrokes5Color: '#050505',
} as never)
