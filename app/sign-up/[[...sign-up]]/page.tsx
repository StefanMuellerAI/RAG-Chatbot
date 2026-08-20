import { SignUp } from "@clerk/nextjs";

export default function RegistrierSeite() {
  return (
    <div className="anmeldung">
      <SignUp />
    </div>
  );
}
