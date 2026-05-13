Available chart kinds (each used as the language tag of a fenced code block):

`bar` — categorical comparisons (vertical or horizontal, single, grouped or stacked).
{ "title": "Revenue by quarter",
  "xLabel": "Quarter", "yLabel": "Revenue", "unit": "USD", "valueFormat": "currency",
  "orientation": "vertical",   // or "horizontal"
  "stacked": false,            // for grouped multi-series
  "categories": ["Q1","Q2","Q3","Q4"],
  "series": [
    { "name": "Product A", "values": [120000, 150000, 180000, 210000] },
    { "name": "Product B", "values": [80000,  90000,  110000, 130000] }
  ] }

`line` — multi-series trend over an ordered axis.
{ "title": "Daily active users",
  "xLabel": "Day", "yLabel": "Users", "valueFormat": "compact",
  "categories": ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],
  "series": [
    { "name": "iOS",     "values": [1200,1300,1250,1400,1500,1700,1650] },
    { "name": "Android", "values": [ 900, 950, 980,1100,1200,1350,1300] }
  ],
  "smooth": true, "showPoints": true }

`area` — same shape as line; the area under each series is filled.

`pie` / `donut` — proportional composition. Use ≤ 8 slices.
{ "title": "Market share", "valueFormat": "percent",
  "slices": [
    { "label": "iOS",     "value": 45 },
    { "label": "Android", "value": 50 },
    { "label": "Other",   "value":  5 }
  ] }

`scatter` — correlation between two numeric variables.
{ "title": "Price vs rating",
  "xLabel": "Price (USD)", "yLabel": "Rating",
  "series": [
    { "name": "Electronics", "points": [
      { "x": 19.99, "y": 4.2, "label": "Cable" },
      { "x": 199.0, "y": 4.6, "label": "Headphones" }
    ] }
  ] }

`heatmap` — matrix of values across two categorical axes.
{ "title": "Activity by hour and day",
  "xLabel": "Hour", "yLabel": "Day",
  "xCategories": ["0","6","12","18"],
  "yCategories": ["Mon","Tue","Wed","Thu","Fri"],
  "values": [
    [3,15,22, 9],[4,16,24,10],[5,18,26,11],[4,17,25,10],[3,19,28,12]
  ],
  "colorScale": "sequential" }

`kpi` — at-a-glance stat cards. Add `delta` + `good` for a directional cue.
{ "title": "This month",
  "columns": 3,
  "cards": [
    { "label": "Revenue", "value": 1250000, "valueFormat": "currency", "unit": "USD",
      "delta": 12.5, "deltaUnit": "%", "deltaDirection": "up", "good": "up",
      "sparkline": [110,120,115,130,135,140,138,145,150] },
    { "label": "Active users", "value": 45200, "valueFormat": "compact",
      "delta": -3.1, "deltaUnit": "%", "deltaDirection": "down", "good": "up" },
    { "label": "Avg latency", "value": 142, "unit": "ms",
      "delta": 8, "deltaUnit": "ms", "deltaDirection": "up", "good": "down" }
  ] }

`relationships` / `flow` — entity boxes with labelled directed edges.
{ "title": "Order schema",
  "nodes": [
    { "id": "Order",    "label": "Order",    "subtitle": "12K rows" },
    { "id": "Customer", "label": "Customer", "subtitle": "3K rows" }
  ],
  "edges": [ { "from": "Order", "to": "Customer", "label": "customer_id" } ] }

`dashboard` — compose multiple charts in a 12-column grid. Items reference any of the kinds above (including `relationships` and `flow`) and pick a column `width` (1–12). Use this when the answer benefits from several views together (KPIs above, trend + breakdown side-by-side, dependency graph + bar charts, etc).
{ "title": "Sales — March 2026",
  "items": [
    { "kind": "kpi",  "width": 12, "spec": { "cards": [
        { "label": "Revenue",  "value": 1250000, "valueFormat": "currency", "unit": "USD" },
        { "label": "Orders",   "value": 8400 },
        { "label": "Avg cart", "value": 148, "valueFormat": "currency", "unit": "USD" }
    ] } },
    { "kind": "line", "width": 8, "spec": { "title": "Daily revenue",
        "xLabel": "Day", "yLabel": "Revenue", "valueFormat": "currency", "unit": "USD",
        "categories": ["1","2","3","4","5","6","7"],
        "series": [ { "name": "Revenue", "values": [42,38,55,61,49,72,68] } ] } },
    { "kind": "donut", "width": 4, "spec": { "title": "By channel", "valueFormat": "percent",
        "slices": [
          { "label": "Web",    "value": 62 },
          { "label": "Mobile", "value": 30 },
          { "label": "Other",  "value":  8 }
        ] } },
    { "kind": "relationships", "width": 12, "spec": {
        "title": "Entity dependency graph",
        "nodes": [
          { "id": "A", "label": "TableA", "subtitle": "3 inserts" },
          { "id": "B", "label": "TableB", "subtitle": "1 update" }
        ],
        "edges": [ { "from": "A", "to": "B", "label": "FK" } ] } }
  ] }

When in doubt, prefer:
- bar for "rank top N" or "category vs value"
- line / area for "trend over time"
- pie / donut for "share of a whole" with ≤ 8 slices
- scatter for "is X correlated with Y?"
- heatmap for "how does value change across two categorical dims?"
- kpi for executive summary metrics
- dashboard to combine the above into one report