"""Best Fit seed for the fixed M1 search screen."""

# EVOLVE-BLOCK-START
def choose_bin(item, remaining_capacities):
    # Absolute slack cap: large items must fit tightly to avoid wasting
    # capacity on a single large item, while small items can tolerate
    # more leftover room.
    if item <= 20:
        absolute_cap = 40
    elif item <= 60:
        absolute_cap = 30
    else:
        absolute_cap = 25

    # Cascade through increasingly loose residual tolerances so we strongly
    # prefer tight fits but still use existing bins when the item is large.
    for max_residual in (item * 1.1, item * 1.5, item * 2.0):
        best_index = -1
        best_residual = None
        for index, remaining in enumerate(remaining_capacities):
            if remaining >= item:
                residual = remaining - item
                if residual > max_residual or residual > absolute_cap:
                    continue
                if best_residual is None or residual < best_residual:
                    best_index = index
                    best_residual = residual
        if best_index != -1:
            return best_index

    # Tight fallback: best-fit but only if residual is at most `item`
    # (i.e., the leftover is no larger than the item we just placed).
    best_index = -1
    best_residual = None
    for index, remaining in enumerate(remaining_capacities):
        if remaining >= item:
            residual = remaining - item
            if residual > item:
                continue
            if best_residual is None or residual < best_residual:
                best_index = index
                best_residual = residual
    return best_index
# EVOLVE-BLOCK-END