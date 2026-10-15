"""Tiny candidate worker; the Docker container is the security boundary."""

import json
import sys


SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "Exception": Exception,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "range": range,
    "reversed": reversed,
    "round": round,
    "set": set,
    "sorted": sorted,
    "sum": sum,
    "tuple": tuple,
    "ValueError": ValueError,
    "zip": zip,
}


def load_candidate():
    with open("/candidate.py", "r", encoding="utf-8") as handle:
        source = handle.read()
    return source


def run_instance(source, items):
    namespace = {"__builtins__": SAFE_BUILTINS, "__name__": "candidate"}
    exec(compile(source, "/candidate.py", "exec"), namespace, namespace)
    choose_bin = namespace.get("choose_bin")
    if not callable(choose_bin):
        raise ValueError("MISSING_CHOOSE_BIN")

    remaining = []
    choices = []
    for item in items:
        choice = choose_bin(item, list(remaining))
        if isinstance(choice, bool) or not isinstance(choice, int):
            raise ValueError("NON_INTEGER_CHOICE")
        choices.append(choice)
        if choice == -1:
            remaining.append(150 - item)
        elif choice < 0 or choice >= len(remaining):
            raise ValueError("INVALID_BIN_INDEX")
        elif remaining[choice] < item:
            raise ValueError("CAPACITY_EXCEEDED")
        else:
            remaining[choice] -= item
    return len(remaining), choices


def main():
    source = load_candidate()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            counts = []
            choices = []
            for items in request["instances"]:
                count, instance_choices = run_instance(source, items)
                counts.append(count)
                choices.append(instance_choices)
            sys.stdout.write(json.dumps({"counts": counts, "choices": choices}) + "\n")
            sys.stdout.flush()
        except Exception as error:  # the host records this as an invalid candidate
            sys.stdout.write(json.dumps({"error": str(error)[:1000]}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
