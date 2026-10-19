"use client";

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Order {
  id: string;
  status: string;
  createdAt: string;
  quantity: number;
}
interface Reservation {
  id: string;
  expiresAt: string;
  order: Order;
}
interface Drop {
  product: { name: string; totalStock: number; availableStock: number };
  held: number;
  sold: number;
  waiting: number;
  users: { id: string; name: string }[];
}
interface Session {
  reservation: Reservation | null;
  serverTime: string;
  receivedAt: number;
  queue: { entry: { id: string } | null; position: number | null };
  orders: Order[];
}
async function api<T>(
  path: string,
  userId?: string,
  method = "GET",
  body?: object,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    cache: "no-store",
    headers: {
      ...(userId ? { "x-demo-user": userId } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message ?? "Unable to reach the drop. Please try again.",
    );
  return data;
}
function subscribeUser(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("demo-user", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("demo-user", callback);
  };
}
function currentUser() {
  return localStorage.getItem("sneaker-user") || "demo-1";
}
function chooseUser(id: string) {
  localStorage.setItem("sneaker-user", id);
  window.dispatchEvent(new Event("demo-user"));
}
function DropPage() {
  const client = useQueryClient();
  const userId = useSyncExternalStore(
    subscribeUser,
    currentUser,
    () => "demo-1",
  );
  const drop = useQuery({
    queryKey: ["drop"],
    queryFn: () => api<Drop>("/drop"),
    refetchInterval: 5000,
  });
  useEffect(() => {
    const source = new EventSource("/api/events");
    const refresh = () => {
      void client.invalidateQueries();
    };
    source.addEventListener("refresh", refresh);
    return () => source.close();
  }, [client]);
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Sneaker Drop
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          20 pairs - Limited edition
        </p>
      </header>
      <Alert>
        <AlertTitle>Try the demo</AlertTitle>
        <AlertDescription>
          Switch users to try reservations and the waiting queue. Payments are
          simulated.
        </AlertDescription>
      </Alert>
      {drop.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading the drop…
        </p>
      ) : drop.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn’t load the drop</AlertTitle>
          <AlertDescription>{drop.error.message}</AlertDescription>
          <Button
            className="mt-3 w-fit"
            variant="outline"
            size="sm"
            onClick={() => drop.refetch()}
          >
            Retry
          </Button>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Edition 001</h2>
            </CardTitle>
            <CardDescription>A limited sneaker drop.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <Image
                src="https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1200&q=80"
                alt="Red Nike sneaker on a red background"
                width={1200}
                height={900}
                unoptimized
                loading="eager"
                className="aspect-4/3 w-full rounded-lg object-cover"
              />
            </div>
            <div className="min-w-0 space-y-5">
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {drop.data.product.availableStock}{" "}
                  <span className="text-base font-normal text-muted-foreground">
                    / {drop.data.product.totalStock} available
                  </span>
                </p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>{drop.data.held} on hold</span>
                  <span>{drop.data.sold} purchased</span>
                  <span>{drop.data.waiting} in queue</span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="demo-user">TRY THE DROP AS</Label>
                <NativeSelect
                  id="demo-user"
                  className="w-full"
                  value={userId}
                  onChange={(event) => chooseUser(event.target.value)}
                >
                  {drop.data.users.map((user) => (
                    <NativeSelectOption key={user.id} value={user.id}>
                      {user.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">
                  Development-only user switching.
                </p>
              </div>
              <DropSession
                key={userId}
                userId={userId}
                available={drop.data.product.availableStock}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function DropSession({
  userId,
  available,
}: {
  userId: string;
  available: number;
}) {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [mode, setMode] = useState("random");
  const [message, setMessage] = useState("");
  const session = useQuery({
    queryKey: ["me", userId],
    refetchInterval: 5000,
    queryFn: async (): Promise<Session> => {
      const [reservation, queue, orders] = await Promise.all([
        api<{ reservation: Reservation | null; serverTime: string }>(
          "/reservations/me",
          userId,
        ),
        api<Session["queue"]>("/queue/me", userId),
        api<{ orders: Order[] }>("/orders/me", userId),
      ]);
      return {
        ...reservation,
        queue,
        orders: orders.orders,
        receivedAt: Date.now(),
      };
    },
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const action = useMutation({
    mutationFn: async (kind: "reserve" | "queue" | "cancel" | "pay") => {
      setMessage("");
      if (kind === "reserve") await api("/reservations", userId, "POST", {});
      if (kind === "queue") await api("/queue", userId, "POST", {});
      if (kind === "cancel") await api("/reservations/me", userId, "DELETE");
      if (kind === "pay") {
        await api("/payments/simulate", userId, "POST", {
          orderId: session.data?.reservation?.order.id,
          mode,
        });
        setMessage(
          mode === "late"
            ? "Payment scheduled after your hold expires. The order will require a simulated refund."
            : "Payment scheduled. Your order status will update when it arrives.",
        );
      }
    },
    onSettled: () => client.invalidateQueries(),
  });
  if (session.isPending)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading your reservation…
      </p>
    );
  if (session.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{session.error.message}</AlertDescription>
      </Alert>
    );
  const { reservation, queue, orders, serverTime, receivedAt } = session.data;
  const serverNow = now + new Date(serverTime).getTime() - receivedAt;
  const seconds = reservation
    ? Math.max(
        0,
        Math.ceil(
          (new Date(reservation.expiresAt).getTime() - serverNow) / 1000,
        ),
      )
    : 0;
  const paid = orders
    .filter((order) => order.status === "PAID")
    .reduce((sum, order) => sum + order.quantity, 0);
  return (
    <div className="space-y-4">
      {reservation ? (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {seconds > 0 ? "Your pair is on hold" : "Your hold has expired"}
            </p>
            <span
              className="font-mono text-lg tabular-nums"
              role="timer"
              aria-label="Time remaining"
            >
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {seconds > 0
              ? "Pay before the timer runs out."
              : "Waiting for the server to release the reservation."}
          </p>
          <div className="space-y-2">
            <Label htmlFor="payment-mode">SIMULATE PAYMENT DELIVERY</Label>
            <NativeSelect
              id="payment-mode"
              className="w-full"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <NativeSelectOption value="random">
                Random delays + possible duplicates
              </NativeSelectOption>
              <NativeSelectOption value="out_of_order">
                Success first + duplicate success
              </NativeSelectOption>
              <NativeSelectOption value="late">
                Late success → refund required
              </NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Button
              disabled={
                action.isPending ||
                seconds === 0 ||
                !!message ||
                reservation.order.status === "PROCESSING"
              }
              onClick={() => action.mutate("pay")}
            >
              {reservation.order.status === "PROCESSING"
                ? "Payment processing…"
                : "Pay with demo gateway"}
            </Button>
            <Button
              variant="outline"
              disabled={action.isPending || seconds === 0}
              onClick={() => action.mutate("cancel")}
            >
              Cancel reservation
            </Button>
          </div>
        </div>
      ) : queue.entry ? (
        <Alert>
          <AlertTitle>You’re in line. #{queue.position}</AlertTitle>
          <AlertDescription>
            You’ll get a five-minute reservation when a pair is allocated to
            you.
          </AlertDescription>
        </Alert>
      ) : paid >= 2 ? (
        <Alert>
          <AlertTitle>Purchase limit reached</AlertTitle>
          <AlertDescription>
            You’ve purchased two pairs from this drop.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-2">
          <Button
            className="w-full"
            disabled={action.isPending}
            onClick={() => action.mutate(available > 0 ? "reserve" : "queue")}
          >
            {action.isPending
              ? "Working…"
              : available > 0
                ? "Reserve my pair"
                : "Join the queue"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Your reservation lasts five minutes.
          </p>
        </div>
      )}
      {action.isError && (
        <Alert variant="destructive">
          <AlertDescription>{action.error.message}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <section
        className="space-y-3 border-t pt-4"
        aria-labelledby="orders-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="orders-heading" className="text-sm font-medium">
            Your orders
          </h3>
          <span className="text-xs text-muted-foreground">
            {paid} / 2 pairs purchased
          </span>
        </div>
        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <p className="font-medium">#{order.id.slice(-8)}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </p>
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      data-status={order.status}
                      variant={
                        order.status === "REFUND_REQUIRED"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {order.status.replaceAll("_", " ")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 1000 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <DropPage />
    </QueryClientProvider>
  );
}
