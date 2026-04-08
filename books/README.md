# Shared Book Files

Pre-analyzed book files for [BookBuddy](../).
Import any `.bookbuddy` or `.etbook` file directly into the app — no EPUB or AI model required.

## How to import

- **Web:** drag and drop the `.bookbuddy` file onto the upload area, or click to browse
- **Android:** use the "Import .etbook" button in the My Books tab

## How to contribute

### From the app (recommended)
1. Analyze a book fully in BookBuddy
2. Open the **My Books** tab
3. Click the **↑** button next to the book
4. Follow the prompts — download the ZIP, attach it to the GitHub issue
5. A pull request will be created automatically for review

### Manual (developers)
1. Export the book (↓ button)
2. Fork this repo, add the file to `books/AuthorName/`, and open a PR

Please only share books that are in the public domain or that you own.

## File format

`.bookbuddy` and `.etbook` files are JSON containing character data, locations, and chapter summaries up to the point you analyzed. They contain **no EPUB text** — only the analysis output.
