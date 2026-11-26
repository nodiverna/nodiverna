// The shared look of the recharts charts (nodiverna-ui §8 "Data shows its shape"): one series in the data color
// --sd-meter, never the scheme accent, and one tooltip style from the --sd-chart-tooltip-* tokens. Every recharts
// Tooltip spreads chartTooltip and sets no style of its own, so the hover feedback reads the same in every mode and
// scheme. recharts merges contentStyle over its own white box, so the background is set as backgroundColor.

/** The stroke and fill of a single-series line or area. */
export const chartSeries='var(--sd-meter)';

/** The props of every recharts Tooltip: the box, the label (time), the value rows and the hover cursor. */
export const chartTooltip={
 contentStyle:{backgroundColor:'var(--sd-chart-tooltip-bg)',border:'1px solid var(--sd-chart-tooltip-line)',borderRadius:'var(--sd-radius-sm)',boxShadow:'var(--sd-shadow-md)',color:'var(--sd-chart-tooltip-ink)',fontSize:12},
 labelStyle:{color:'var(--sd-chart-tooltip-muted)'},
 itemStyle:{color:'var(--sd-chart-tooltip-ink)'},
 cursor:{stroke:chartSeries,strokeDasharray:'3 3'},
} as const;
