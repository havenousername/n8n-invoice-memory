"""Assemble importable n8n workflow JSON from workflows/code (pure functions) and workflows/nodes (Code-node glue).

Run after changing either folder: python3 scripts/build_workflows.py
The output carries no instance ids: Data Tables are referenced by name, credentials by name, and the cluster
URL is a placeholder to set in the Config node after import.
"""

import json
import re
import sys
import uuid
from collections.abc import Mapping
from pathlib import Path

WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / "workflows"
QDRANT_URL_PLACEHOLDER = "https://REPLACE.cloud.qdrant.io:6333"
QDRANT_CREDENTIAL = {"httpHeaderAuth": {"name": "Qdrant api-key"}}
_ID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/qdrant/n8n-invoice-memory")
_FROM_CONFIG = "={{{{ $('Config').first().json.{} }}}}"


def pasted(source: str) -> str:
    """A pure-function source as a Code node needs it: no module.exports, since there is no require."""
    return re.sub(r"^module\.exports.*\n?", "", source, flags=re.MULTILINE)


def read_parts() -> tuple[dict[str, str], str]:
    sources = {name: (WORKFLOWS_DIR / "code" / f"{name}.js").read_text() for name in ("ids", "view")}
    glue = (WORKFLOWS_DIR / "nodes" / "compute-the-view.js").read_text()
    return sources, glue


def rebuild_point(sources: Mapping[str, str], glue: str) -> dict:
    """03 Rebuild point: the only writer to Qdrant. Inputs customer_id and manager_id."""
    workflow = "03 Rebuild point"
    trigger = "When Executed by Another Workflow"
    steps = [
        _node(workflow, trigger, "n8n-nodes-base.executeWorkflowTrigger", 1.1, 0, {
            "inputSource": "workflowInputs",
            "workflowInputs": {"values": [{"name": "customer_id", "type": "string"},
                                          {"name": "manager_id", "type": "string"}]},
        }),
        _node(workflow, "Config", "n8n-nodes-base.set", 3.4, 1, {
            "assignments": {"assignments": [
                _assignment(workflow, "QDRANT_URL", QDRANT_URL_PLACEHOLDER),
                _assignment(workflow, "COLLECTION", "customers"),
            ]},
            "includeOtherFields": True,
            "options": {},
        }),
        _node(workflow, "Hash the point id", "n8n-nodes-base.crypto", 2, 2, {
            "action": "hash",
            "type": "SHA256",
            "value": "={{ $json.manager_id }}/{{ $json.customer_id }}",
            "dataPropertyName": "idhash",
            "encoding": "hex",
        }),
        _tenant_rows(workflow, "Load the customer row", "customers", 3),
        _tenant_rows(workflow, "Load all invoice rows", "invoices", 4),
        _node(workflow, "Compute the view", "n8n-nodes-base.code", 2, 5, {
            "jsCode": pasted(sources["ids"]) + pasted(sources["view"]) + glue,
        }),
        _node(workflow, "Upsert the point with inference", "n8n-nodes-base.httpRequest", 4.2, 6, {
            "method": "PUT",
            "url": "={{ $('Config').first().json.QDRANT_URL }}/collections/"
                   "{{ $('Config').first().json.COLLECTION }}/points?wait=true",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.body) }}",
            "options": {},
        }, credentials=QDRANT_CREDENTIAL),
    ]
    note = _node(workflow, "Sticky Note", "n8n-nodes-base.stickyNote", 1, 2, {
        "content": "Source of truth is the two Data Tables. This workflow is the only writer to Qdrant. "
                   "Any stage, any retry, same point.",
        "width": 380,
        "height": 140,
    })
    note["position"] = [440, -220]
    return {
        "name": workflow,
        "nodes": [*steps, note],
        "connections": _chain([s["name"] for s in steps]),
        "pinData": {trigger: [{"json": {"customer_id": "acme", "manager_id": "m_anna"}}]},
        "settings": {"executionOrder": "v1"},
    }


def _node(workflow: str, name: str, type_: str, version: float, column: int, parameters: dict, **extra) -> dict:
    return {
        "id": str(uuid.uuid5(_ID_NAMESPACE, f"{workflow}/{name}")),
        "name": name,
        "type": type_,
        "typeVersion": version,
        "position": [column * 220, 0],
        "parameters": parameters,
        **extra,
    }


def _assignment(workflow: str, name: str, value: str) -> dict:
    return {"id": str(uuid.uuid5(_ID_NAMESPACE, f"{workflow}/Config/{name}")), "name": name, "value": value, "type": "string"}


def _tenant_rows(workflow: str, name: str, table: str, column: int) -> dict:
    """Every row of `table` for the Config tenant and customer. Runs once; an empty item when nothing matches."""
    return _node(workflow, name, "n8n-nodes-base.dataTable", 1.1, column, {
        "resource": "row",
        "operation": "get",
        "dataTableId": {"__rl": True, "mode": "name", "value": table},
        "matchType": "allConditions",
        "filters": {"conditions": [
            {"keyName": key, "condition": "eq", "keyValue": _FROM_CONFIG.format(key)}
            for key in ("customer_id", "manager_id")
        ]},
        "returnAll": True,
    }, alwaysOutputData=True, executeOnce=True)


def _chain(names: list[str]) -> dict:
    return {
        source: {"main": [[{"node": target, "type": "main", "index": 0}]]}
        for source, target in zip(names, names[1:])
    }


def main() -> int:
    out = WORKFLOWS_DIR / "03-rebuild-point.json"
    out.write_text(json.dumps(rebuild_point(*read_parts()), indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out.relative_to(WORKFLOWS_DIR.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
