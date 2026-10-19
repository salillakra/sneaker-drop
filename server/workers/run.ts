import { config } from "../config";
import { prisma } from "../../lib/prisma";
import { expireReservations } from "../services/inventory";
import { deliverPayments } from "../services/payments";

let stopping = false;
let wake: (() => void) | undefined;
function stop() {
  stopping = true;
  wake?.();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function main() {
  console.log(
    "Sneaker Drop workers started: expiry + durable payment delivery",
  );
  while (!stopping) {
    try {
      await expireReservations();
      await deliverPayments();
    } catch (error) {
      console.error("Worker tick failed; retrying next tick", error);
    }
    if (!stopping)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.WORKER_INTERVAL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
