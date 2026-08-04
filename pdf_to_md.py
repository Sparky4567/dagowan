import sys
import re
import argparse
from pathlib import Path

def extract_text_from_pdf(pdf_path: Path) -> list[dict]:
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
        
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        pages_data = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            pages_data.append({"page_num": i + 1, "text": text})
        return pages_data
    except Exception as e:
        raise RuntimeError(f"Could not extract PDF text (pypdf error: {e})")

def format_text_as_markdown(raw_text: str, title_fallback: str = "Note") -> str:
    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    if not lines:
        return f"# {title_fallback}\n\n"

    md_lines = []
    first_line = True

    for line in lines:
        if first_line:
            md_lines.append(f"# {line}\n")
            first_line = False
        elif line.endswith("?") or (len(line) < 60 and not line.endswith(".") and not line.endswith(":")):
            md_lines.append(f"\n## {line}\n")
        else:
            md_lines.append(line)

    return "\n".join(md_lines)

def split_pdf_pages_to_notes(pages_data: list[dict], pdf_stem: str) -> dict[str, str]:
    notes = {}
    
    for i, page in enumerate(pages_data):
        text = page["text"].strip()
        if not text:
            continue
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            continue

        first_line = lines[0]
        is_date_title = bool(re.match(r"^\d{4}-\d{2}-\d{2}$", first_line)) or bool(re.match(r"^\d{4}-\d{2}$", first_line))
        
        if is_date_title:
            stem = first_line
        elif len(pages_data) == 1:
            stem = pdf_stem
        else:
            clean_title = re.sub(r'[^\w\s-]', '', first_line).strip().replace(" ", "_")
            if clean_title and len(clean_title) <= 40:
                stem = clean_title
            else:
                stem = f"{pdf_stem}_part{i+1}"

        formatted_md = format_text_as_markdown(text, title_fallback=stem)
        if stem in notes:
            notes[stem] += "\n\n---\n\n" + formatted_md
        else:
            notes[stem] = formatted_md

    if not notes and pages_data:
        combined_text = "\n\n".join([p["text"] for p in pages_data])
        notes[pdf_stem] = format_text_as_markdown(combined_text, title_fallback=pdf_stem)

    return notes

def convert_pdf_to_md(
    pdf_path: str | Path,
    output_dir: str | Path = "notes"
) -> tuple[int, list[Path], str]:
    pdf_file = Path(pdf_path)
    notes_dir = Path(output_dir)
    notes_dir.mkdir(parents=True, exist_ok=True)

    if not pdf_file.exists():
        alt_path = Path("pdfs") / pdf_file.name
        if alt_path.exists():
            pdf_file = alt_path
        else:
            return 0, [], f"PDF file '{pdf_path}' not found."

    try:
        pages_data = extract_text_from_pdf(pdf_file)
    except Exception as e:
        return 0, [], f"Failed to read PDF file '{pdf_file.name}': {e}"

    if not pages_data:
        return 0, [], f"No text could be extracted from '{pdf_file.name}'."

    notes_dict = split_pdf_pages_to_notes(pages_data, pdf_stem=pdf_file.stem)
    created_mds = []

    for note_stem, md_content in notes_dict.items():
        out_path = notes_dir / f"{note_stem}.md"
        out_path.write_text(md_content, encoding="utf-8")
        created_mds.append(out_path)

    return len(created_mds), created_mds, f"Converted PDF '{pdf_file.name}' to {len(created_mds)} markdown note(s) in '{notes_dir}'."

def main():
    parser = argparse.ArgumentParser(description="Convert PDF files back to Markdown notes.")
    parser.add_argument("pdf_file", nargs="?", default="pdfs/notes.pdf", help="Path to PDF file")
    parser.add_argument("--output", default="notes", help="Output directory for Markdown notes")
    args = parser.parse_args()

    count, mds, msg = convert_pdf_to_md(args.pdf_file, args.output)
    print(msg)
    for p in mds:
        print(f" - {p.resolve()}")

if __name__ == "__main__":
    main()
