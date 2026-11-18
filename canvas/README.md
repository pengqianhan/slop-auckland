# Canvas workspace

The canvas edits ordinary project files. Documents are Markdown and media files are available directly under assets/ in the project. Other files imported on the canvas are kept under assets/files/ and shown as file nodes.

| File | Content |
| --- | --- |
| index.json | Board IDs/names, document and table IDs/titles, and mainDocumentId |
| boards/<id>.json | Node IDs, optional titles/descriptions, content and references |
| documents/<id>.md | Canonical document body |
| tables/<id>.json | Typed columns and rows with stable IDs; cells keyed by column ID |
| assets.json | Asset IDs, names, project-relative file paths, descriptions and generation prompts |
| editor/<id>.json | Positions, text/document/table node dimensions and canvas viewport; missing node positions are filled automatically |
| schemas/ | Exact persisted file contracts |
| jobs.json | Generation history managed by the application |

Read AGENTS.md for editing conventions. Asset paths are relative to the project root; Markdown image links are relative to the document file. Node IDs need only be unique within their board; asset, document and table IDs are shared across the canvas workspace.
