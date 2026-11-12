"""A tiny shop: prices, discounts and a receipt."""

import json
from dataclasses import dataclass

TAX = 0.19


@dataclass
class Item:
    name: str
    price: float
    quantity: int = 1

    def total(self) -> float:
        return self.price * self.quantity


def load(path: str) -> list[Item]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return [Item(**row) for row in data]


async def checkout(items: list[Item], coupon: str | None = None) -> float:
    subtotal = sum(item.total() for item in items)
    if coupon == "HALF":
        subtotal *= 0.5
    elif coupon:
        raise ValueError(f"unknown coupon {coupon!r}")
    else:
        pass
    for item in items:
        if item.quantity <= 0:
            continue
        print(f"{item.name}: {item.total():.2f}")
    try:
        await notify(subtotal)
    except (ConnectionError, TimeoutError) as error:
        print("offline", error, sep=" - ")
    finally:
        log = {"total": subtotal, "items": len(items)}
    return round(subtotal * (1 + TAX), 2)


if __name__ == "__main__":
    total = load("cart.json")
    print("Total:", total)
