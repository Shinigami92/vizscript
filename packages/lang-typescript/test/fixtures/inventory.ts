interface Item {
  name: string;
  price: number;
  quantity: number;
}

const TAX_RATE = 0.19;

/** Sum of all items including tax, rounded to cents. */
export function totalPrice(items: Item[], discount = 0): number {
  // #region Sum up the cart
  let total = 0;
  for (const item of items) {
    // Out of stock items are not charged
    if (item.quantity <= 0) {
      continue;
    }

    total += item.price * item.quantity;
  }
  // #endregion

  const discounted = total - total * discount;
  return Math.round(discounted * (1 + TAX_RATE) * 100) / 100;
}

export async function loadInventory(url: string): Promise<Item[]> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const items: Item[] = await response.json();
    return items.filter((item) => item.price > 0);
  } catch (error) {
    console.error('Could not load inventory', error);
    return [];
  }
}

const cart: Item[] = [
  { name: 'Keyboard', price: 89.9, quantity: 1 },
  { name: 'Cable', price: 4.5, quantity: 3 },
];

console.log(`Total: ${totalPrice(cart, 0.1)} EUR`);
