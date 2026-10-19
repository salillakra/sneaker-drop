import "../lib/env";
import { prisma } from "../lib/prisma";
import { PRODUCT_ID } from "../server/services/inventory";

async function main() {
  // Re-running the seed preserves live stock, holds, purchases and queue state.
  await prisma.product.upsert({
    where: { id: PRODUCT_ID },
    update: {},
    create: {
      id: PRODUCT_ID,
      name: "SNEAKER DROP / Edition 001",
      totalStock: 20,
      availableStock: 20,
    },
  });
  const names = [
    "Alex Morgan",
    "Riley Chen",
    "Sam Rivera",
    "Jordan Lee",
    "Casey Patel",
    "Taylor Kim",
    "Jamie Brooks",
    "Avery Singh",
    "Drew Williams",
    "Quinn Davis",
    "Morgan Ali",
    "Skyler Park",
    "Cameron Scott",
    "Reese Wilson",
    "Finley Shah",
    "Dakota Bell",
    "Emerson Reed",
    "Harper Tran",
    "Rowan Clark",
    "Parker Green",
    "Sage Thomas",
    "Blair Lewis",
    "Remy Walker",
    "Elliot Jones",
  ];
  for (const [i, name] of names.entries()) {
    await prisma.user.upsert({
      where: { id: `demo-${i + 1}` },
      update: { name, demo: true },
      create: {
        id: `demo-${i + 1}`,
        name,
        email: `demo${i + 1}@sneaker.local`,
        demo: true,
      },
    });
  }
  console.log(
    "Seed complete: Edition 001 and 24 demo users. Existing stock preserved.",
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
