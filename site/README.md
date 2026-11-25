# AIConsumerAgent development guide

This is a dependency-free static site for GitHub Pages. It lives in the site directory and is deployed by the Pages workflow.

## Publish

1. In repository settings, open **Pages** and set the publishing source to **GitHub Actions**.
2. Merge or push the site changes to the main branch, or run **Publish learning guide** from the Actions tab.
3. GitHub Pages publishes the guide at https://meharajm.github.io/WA-copilot/learning/.

The workflow preserves the existing docs site at the repository root and adds this guide under the learning path. It does not build the app or install packages.

## Edit

Update index.html and style.css. Diagrams are inline SVG so they remain crisp, accessible, and dependency-free. The commit chart and timeline summarize all 590 commits reachable from the local and remote refs reviewed for this guide; the source links point to representative commits and current code.

The analysis covers 590 commits reachable in the reviewed checkout through local merge 2adbc41a (2026-09-30). Two local-only commits are counted but are not published to GitHub; 1fe1b0de (2026-09-26) is the last public app commit before this guide. Uncommitted working-tree changes are excluded.
