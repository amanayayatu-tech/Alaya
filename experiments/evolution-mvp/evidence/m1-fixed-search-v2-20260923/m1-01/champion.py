"""Best Fit seed for the fixed M1 search screen."""

# EVOLVE-BLOCK-START
def _scan(item, remaining_capacities):
    """Return (best_idx, best_rem, second_idx, second_rem, worst_idx, worst_rem).

    Scans remaining_capacities once, tracking the tightest feasible bin,
    the second-tightest feasible bin, and the loosest feasible bin.
    Returns -1 indices when a category has no feasible bin.
    """
    best_idx = -1
    best_rem = None
    second_idx = -1
    second_rem = None
    worst_idx = -1
    worst_rem = -1

    for idx, rem in enumerate(remaining_capacities):
        if rem < item:
            continue
        # Track loosest feasible bin (worst-fit).
        if rem > worst_rem:
            worst_idx = idx
            worst_rem = rem
        # Track tightest feasible bin (best-fit) with second-best.
        if best_idx == -1 or rem < best_rem:
            second_idx = best_idx
            second_rem = best_rem
            best_idx = idx
            best_rem = rem
        elif rem == best_rem:
            if idx < best_idx:
                second_idx = best_idx
                second_rem = best_rem
                best_idx = idx
                best_rem = rem
            elif second_idx == -1 or rem < second_rem:
                second_idx = idx
                second_rem = rem
        elif second_idx == -1 or rem < second_rem:
            second_idx = idx
            second_rem = rem

    return best_idx, best_rem, second_idx, second_rem, worst_idx, worst_rem


def _worst_fit_tier(item, best_idx, best_rem, worst_idx, worst_rem):
    """For small items, consolidate into a roomy bin when it preserves
    a meaningfully tighter alternative for larger future items.
    Returns chosen index or None if tier doesn't apply."""
    if worst_idx == -1 or worst_idx == best_idx:
        return None
    worst_slack = worst_rem - item
    best_slack = best_rem - item
    # For small items, prefer worst-fit to consolidate and preserve
    # tight bins for larger future items.
    if item <= 20:
        # Require worst-fit to leave useful slack and be meaningfully
        # roomier than best-fit.
        if (worst_slack >= max(item // 2, 3)
                and worst_rem >= best_rem + item // 2 + 2
                and best_slack > max(item // 4, 1)):
            return worst_idx
    else:
        # For larger items, only worst-fit when bin is dramatically roomier.
        if (worst_slack >= max(item // 2, 4)
                and worst_rem >= 2 * best_rem
                and best_slack > max(item // 4, 1)):
            return worst_idx
    return None


def _second_fit_tier(item, best_rem, second_idx, second_rem):
    """When best-fit wastes meaningful space and a roomier fit exists,
    prefer the roomier fit to avoid fragmenting tight bins."""
    if second_idx == -1 or second_rem <= best_rem:
        return None
    slack = best_rem - item
    threshold = max(item // 4, 2)
    if slack > threshold:
        return second_idx
    return None


def choose_bin(item, remaining_capacities):
    # Tiered selection: worst-fit (small items) -> second-fit (slack) -> best-fit.
    best_idx, best_rem, second_idx, second_rem, worst_idx, worst_rem = _scan(
        item, remaining_capacities
    )

    if best_idx == -1:
        return -1  # No feasible bin -> open a new one.

    choice = _worst_fit_tier(item, best_idx, best_rem, worst_idx, worst_rem)
    if choice is not None:
        return choice

    choice = _second_fit_tier(item, best_rem, second_idx, second_rem)
    if choice is not None:
        return choice

    return best_idx
# EVOLVE-BLOCK-END