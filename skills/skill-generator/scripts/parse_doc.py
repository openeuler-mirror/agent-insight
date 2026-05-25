#!/usr/bin/env python3
"""
Lightweight Document Parser

This script converts complex documents (PDFs, URLs, HTML) into pure Markdown text.
It contains NO LLM dependencies and is designed entirely to serve as a pre-processor for an Agent.

Usage:
  python parse_doc.py <input_path_or_url> [-o <output_path>]
"""

import argparse
import os
import sys

def parse_url(url: str) -> str:
    try:
        import requests
        from bs4 import BeautifulSoup
        import markdownify

        response = requests.get(url, timeout=10)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, "html.parser")

        # Remove noisy elements
        for element in soup(["script", "style", "nav", "footer", "header", "noscript"]):
            element.decompose()

        md_text = markdownify.markdownify(str(soup), heading_style="ATX")
        return md_text
    except ImportError:
        print("Error: Missing dependencies for URL parsing. Please install beautifulsoup4, markdownify, and requests.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error parsing URL {url}: {e}", file=sys.stderr)
        sys.exit(1)

def parse_pdf(pdf_path: str) -> str:
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(pdf_path)
        parts = []
        for i, page in enumerate(doc):
            text = page.get_text("text")
            if text.strip():
                parts.append(f"<!-- Page {i+1} -->\n{text}")
        doc.close()
        return "\n\n".join(parts)
    except ImportError:
        print("Error: PyMuPDF not installed. Please install PyMuPDF.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error parsing PDF {pdf_path}: {e}", file=sys.stderr)
        sys.exit(1)

def parse_file(file_path: str) -> str:
    if not os.path.exists(file_path):
        print(f"Error: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".pdf":
        return parse_pdf(file_path)
    elif ext in [".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".sh", ".py"]:
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()
    elif ext in [".html", ".htm"]:
        with open(file_path, "r", encoding="utf-8") as f:
            html_content = f.read()
            try:
                from bs4 import BeautifulSoup
                import markdownify
                soup = BeautifulSoup(html_content, "html.parser")
                for element in soup(["script", "style", "nav", "footer"]):
                    element.decompose()
                return markdownify.markdownify(str(soup), heading_style="ATX")
            except ImportError:
                return html_content # fallback to raw
    else:
        print(f"Warning: Unsupported extension '{ext}', treating as raw text.", file=sys.stderr)
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return f.read()
        except UnicodeDecodeError:
            print(f"Error: Could not read {file_path} as utf-8 text.", file=sys.stderr)
            sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="Convert documents to pure Markdown text.")
    parser.add_argument("input", help="Path to a file (PDF, MD, HTML, etc) or a URL")
    parser.add_argument("-o", "--output", help="Optional output file. If omitted, prints to stdout.")

    args = parser.parse_args()

    source = args.input
    if source.startswith("http://") or source.startswith("https://"):
        result_text = parse_url(source)
    else:
        result_text = parse_file(source)

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(result_text)
            print(f"Extraction successful: Saved to {args.output}")
        except Exception as e:
            print(f"Error writing to output file {args.output}: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print(result_text)

if __name__ == "__main__":
    main()
