# ENAI Ambassador Training

Self-paced microlearning for ENAI Student Ambassadors. Static site for GitHub Pages,
with progress stored in Supabase (project "ENAI Ambassador Training").

## Files
- index.html, styles.css, app.js: the app
- parser.js: reads the module Markdown files
- config.js: Supabase URL, publishable key, optional upload form link
- content/: the seven module files (see content/README.md)
- assets/logo.png: ENAI Student Ambassadors logo
- .github/workflows/supabase-keepalive.yml: pings Supabase every 3 days so the free project doesn't pause

## Setup
1. Create a new public GitHub repository, for example "ambassador-training", and upload all files.
2. Settings > Pages: deploy from branch "main", folder "/ (root)".
3. Add the module files to content/ (see content/README.md).
4. Settings > Secrets and variables > Actions: add SUPABASE_URL and SUPABASE_KEY for the keep-alive workflow.
5. In Supabase (Authentication > URL Configuration): set Site URL and add a Redirect URL
   for the GitHub Pages address, e.g. https://<user>.github.io/ambassador-training/
6. In Supabase (Authentication > Emails > Magic Link template): add {{ .Token }} so the email shows a 6-digit code
   as well as the link.
7. In Supabase (Authentication > Emails > SMTP Settings): connect the ENAI Google Workspace account,
   so login emails are reliable and come from an ENAI address.
