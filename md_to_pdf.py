import sys
import re
import argparse
from pathlib import Path
from datetime import datetime

INPUT_DIR = Path("notes")
OUTPUT_DIR = Path("pdfs")
SORT_MODE = "name"

def parse_date(date_str: str, default_end: bool = False) -> datetime | None:
    if not date_str:
        return None
    date_str = date_str.strip()
    try:
        if re.match(r"^\d{4}-\d{2}$", date_str):
            dt = datetime.strptime(date_str, "%Y-%m")
            if default_end:
                if dt.month == 12:
                    return datetime(dt.year, 12, 31, 23, 59, 59)
                else:
                    next_month = datetime(dt.year, dt.month + 1, 1)
                    return datetime.fromtimestamp(next_month.timestamp() - 1)
            return datetime(dt.year, dt.month, 1, 0, 0, 0)
        elif re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            dt = datetime.strptime(date_str, "%Y-%m-%d")
            if default_end:
                return datetime(dt.year, dt.month, dt.day, 23, 59, 59)
            return datetime(dt.year, dt.month, dt.day, 0, 0, 0)
        elif re.match(r"^\d{4}$", date_str):
            year = int(date_str)
            if default_end:
                return datetime(year, 12, 31, 23, 59, 59)
            return datetime(year, 1, 1, 0, 0, 0)
    except Exception:
        pass
    return None

def extract_file_date(file_path: Path) -> datetime:
    match_ymd = re.search(r"(\d{4}-\d{2}-\d{2})", file_path.name)
    if match_ymd:
        try:
            return datetime.strptime(match_ymd.group(1), "%Y-%m-%d")
        except ValueError:
            pass
    match_ym = re.search(r"(\d{4}-\d{2})", file_path.name)
    if match_ym:
        try:
            return datetime.strptime(match_ym.group(1), "%Y-%m")
        except ValueError:
            pass
    return datetime.fromtimestamp(file_path.stat().st_mtime)

def get_markdown_files(directory: Path, from_date: str = "", to_date: str = "", sort_mode: str = "name"):
    directory = Path(directory)
    if directory.is_file() and directory.suffix == ".md":
        files = [directory]
    elif directory.exists():
        files = list(directory.rglob("*.md"))
    else:
        files = []

    filtered_files = []
    for f in files:
        parts = [p.lower() for p in f.parts]
        if any(p.startswith(".") or p in ["venv", ".venv", "node_modules", "pdfs", "backups"] for p in parts):
            continue
        filtered_files.append(f)

    from_dt = parse_date(from_date, default_end=False)
    to_dt = parse_date(to_date, default_end=True)

    result = []
    for f in filtered_files:
        file_dt = extract_file_date(f)
        if from_dt and file_dt < from_dt:
            continue
        if to_dt and file_dt > to_dt:
            continue
        result.append(f)

    if sort_mode == "time":
        result.sort(key=lambda f: extract_file_date(f))
    else:
        result.sort(key=lambda f: f.name.lower())

    return result

def convert_notes_to_pdf(
    input_dir: str | Path = "notes",
    output_dir: str | Path = "pdfs",
    from_date: str = "",
    to_date: str = "",
    output_filename: str | None = None
) -> tuple[int, list[Path], str]:
    input_path = Path(input_dir)
    pdf_dir = Path(output_dir)
    pdf_dir.mkdir(parents=True, exist_ok=True)

    md_files = get_markdown_files(input_path, from_date=from_date, to_date=to_date)
    if not md_files and input_path.name == "notes" and not input_path.exists():
        md_files = get_markdown_files(Path("."), from_date=from_date, to_date=to_date)

    if not md_files:
        return 0, [], f"No markdown files found matching date range ({from_date or 'beginning'} to {to_date or 'latest'})."

    created_pdfs = []

    # Attempt importing markdown & weasyprint if available
    try:
        import markdown
        from weasyprint import HTML

        def build_html_document(body: str, title: str = "Markdown Notes"):
            return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{title}</title><style>body {{ font-family: sans-serif; line-height: 1.6; padding: 20px; color: #333; }} h1 {{ border-bottom: 2px solid #0056b3; padding-bottom: 5px; color: #0056b3; }} table {{ border-collapse: collapse; width: 100%; }} th, td {{ border: 1px solid #dee2e6; padding: 8px 12px; }}</style></head><body>{body}</body></html>"""

        for f in md_files:
            single_html = markdown.markdown(f.read_text(encoding="utf-8"), extensions=['tables', 'fenced_code'])
            doc_html = build_html_document(f"<h1>{f.stem}</h1>\n{single_html}", title=f.stem)
            single_pdf_path = pdf_dir / f"{f.stem}.pdf"
            HTML(string=doc_html).write_pdf(single_pdf_path)
            created_pdfs.append(single_pdf_path)

        if not output_filename:
            d_from = from_date.strip().replace(":", "-") if from_date else "start"
            d_to = to_date.strip().replace(":", "-") if to_date else "end"
            output_filename = f"notes_{d_from}_to_{d_to}.pdf"

        html_parts = [f"<h1>{f.stem}</h1>\n" + markdown.markdown(f.read_text(encoding="utf-8"), extensions=['tables', 'fenced_code']) for f in md_files]
        merged_html = "\n<hr>\n".join(html_parts)
        full_html = build_html_document(merged_html, title="Batch Markdown Notes")
        batch_pdf_path = pdf_dir / output_filename
        HTML(string=full_html).write_pdf(batch_pdf_path)
        created_pdfs.append(batch_pdf_path)

        return len(md_files), created_pdfs, f"Converted {len(md_files)} note file(s) to PDF in '{pdf_dir}'."
    except Exception as e:
        # Fallback text/HTML compilation when weasyprint is not installed
        out_txt = pdf_dir / "notes_compiled.md"
        compiled = "\n\n---\n\n".join([f"# {f.stem}\n" + f.read_text(encoding="utf-8") for f in md_files])
        out_txt.write_text(compiled, encoding="utf-8")
        return len(md_files), [out_txt], f"Compiled {len(md_files)} markdown notes into '{out_txt}' (weasyprint fallback: {e})."

def main():
    parser = argparse.ArgumentParser(description="Convert Markdown notes to PDF batches.")
    parser.add_argument("--input", default="notes", help="Input directory containing markdown files")
    parser.add_argument("--output", default="pdfs", help="Output directory for PDF files")
    parser.add_argument("--from-date", default="", help="Start date filter (e.g. 2026-07)")
    parser.add_argument("--to-date", default="", help="End date filter (e.g. 2026-08)")
    args = parser.parse_args()

    count, pdfs, msg = convert_notes_to_pdf(
        input_dir=args.input,
        output_dir=args.output,
        from_date=args.from_date,
        to_date=args.to_date
    )
    print(msg)
    for p in pdfs:
        print(f" - {p.resolve()}")

if __name__ == "__main__":
    main()
