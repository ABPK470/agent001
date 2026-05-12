```dashboard
{
  "title": "Sync Preview — AfricaMarketsManualAdjustments",
  "items": [
    {
      "kind": "kpi",
      "width": 12,
      "spec": {
        "cards": [
          { "label": "Inserts", "value": 121, "unit": "rows", "valueFormat": "number" },
          { "label": "Updates", "value": 0, "unit": "rows", "valueFormat": "number" },
          { "label": "Deletes", "value": 0, "unit": "rows", "valueFormat": "number" },
          { "label": "Tables Impacted", "value": 7, "unit": "tables", "valueFormat": "number" }
        ]
      }
    },
    {
      "kind": "bar",
      "width": 12,
      "spec": {
        "title": "Changes by Table",
        "xLabel": "Table Name",
        "yLabel": "Row Changes",
        "unit": "rows",
        "valueFormat": "number",
        "orientation": "vertical",
        "categories": ["core.Rule", "core.RuleColumn", "core.RuleCondition", "core.RuleLink", "core.DatasetColumn", "core.Dataset", "core.RuleLinkType"],
        "series": [
          {
            "name": "Inserts",
            "values": [4, 26, 3, 6, 78, 2, 2]
          }
        ]
      }
    }
  ]
}
``````dashboard
{
  "title": "Sync Preview Summary: AfricaMarketsManualAdjustments",
  "items": [
    {
      "kind": "kpi",
      "width": 12,
      "spec": {
        "cards": [
          {
            "label": "Total Inserts",
            "value": 121,
            "valueFormat": "number"
          },
          {
            "label": "Total Updates",
            "value": 0,
            "valueFormat": "number"
          },
          {
            "label": "Total Deletes",
            "value": 0,
            "valueFormat": "number"
          },
          {
            "label": "Tables Affected",
            "value": 7,
            "valueFormat": "number"
          }
        ]
      }
    },
    {
      "kind": "bar",
      "width": 12,
      "spec": {
        "title": "Net Changes by Table",
        "xLabel": "Table",
        "yLabel": "Row Changes",
        "unit": "Records",
        "valueFormat": "number",
        "orientation": "vertical",
        "categories": [
          "core.Rule",
          "core.RuleColumn",
          "core.RuleCondition",
          "core.RuleLink",
          "core.DatasetColumn",
          "core.Dataset",
          "core.RuleLinkType"
        ],
        "series": [
          {
            "name": "Inserts",
            "values": [4, 26, 3, 6, 78, 2, 2]
          }
        ]
      }
    },
    {
      "kind": "relationships",
      "width": 12,
      "spec": {
        "title": "Table Dependency Graph",
        "nodes": [
          { "id": "core.Rule", "label": "core.Rule", "subtitle": "+4 inserts", "color": "green" },
          { "id": "core.RuleColumn", "label": "core.RuleColumn", "subtitle": "+26 inserts", "color": "green" },
          { "id": "core.RuleCondition", "label": "core.RuleCondition", "subtitle": "+3 inserts", "color": "green" },
          { "id": "core.RuleLink", "label": "core.RuleLink", "subtitle": "+6 inserts", "color": "green" },
          { "id": "core.DatasetColumn", "label": "core.DatasetColumn", "subtitle": "+78 inserts", "color": "green" },
          { "id": "core.Dataset", "label": "core.Dataset", "subtitle": "+2 inserts", "color": "green" },
          { "id": "core.RuleLinkType", "label": "core.RuleLinkType", "subtitle": "+2 inserts", "color": "green" }
        ],
        "edges": [
          { "from": "core.Rule", "to": "core.RuleColumn", "label": "Dependency" },
          { "from": "core.Rule", "to": "core.RuleCondition", "label": "Dependency" },
          { "from": "core.Rule", "to": "core.RuleLink", "label": "Dependency" },
          { "from": "core.Dataset", "to": "core.DatasetColumn", "label": "Dependency" }
        ]
      }
    }
  ]
}
```