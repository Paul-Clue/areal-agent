export default function BillingPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-zinc-900">Billing</h1>
      <p className="mt-2 max-w-2xl text-zinc-600">
        Payment processing is not integrated in this app. Subscriptions and checkout will be wired through{' '}
        <strong className="font-medium text-zinc-800">Paddle</strong> (or your chosen provider) later. The app
        already supports a <code className="text-sm">REQUIRE_PAYMENT</code> flag so you can turn on “subscription
        required” when billing goes live; until then, agent sync sets active, unlimited access for development.
      </p>
    </div>
  );
}
