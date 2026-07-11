#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("answer", type=Path)
    parser.add_argument("--ground-truth", type=Path, default=Path(__file__).with_name("ground-truth.json"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    expected = json.loads(args.ground_truth.read_text())
    try:
        answer = json.loads(args.answer.read_text())
        if not isinstance(answer, list):
            raise ValueError("answer is not a JSON array")
    except Exception as error:
        result = {"valid_json_array": False, "error": str(error), "expected": len(expected), "true_positives": 0, "false_positives": 0, "missing": len(expected)}
        text = json.dumps(result, indent=2) + "\n"
        (args.output.write_text(text) if args.output else print(text, end=""))
        return 1

    unmatched = set(range(len(answer)))
    matched = []
    missing = []
    for truth in expected:
        found = None
        for index in sorted(unmatched):
            item = answer[index]
            searchable = f"{item.get('contract', '')} {item.get('defect', '')} {item.get('impact', '')}".lower()
            if item.get("path") == truth["path"] and item.get("line") == truth["line"] and truth["needle"] in searchable:
                found = index
                break
        if found is None:
            missing.append(truth)
        else:
            unmatched.remove(found)
            matched.append(truth)
    result = {
        "valid_json_array": True,
        "expected": len(expected),
        "true_positives": len(matched),
        "false_positives": len(unmatched),
        "missing": missing,
        "unmatched_answer_items": [answer[index] for index in sorted(unmatched)],
    }
    text = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.write_text(text)
    else:
        print(text, end="")
    return 0 if len(matched) == len(expected) and not unmatched else 1


if __name__ == "__main__":
    raise SystemExit(main())
