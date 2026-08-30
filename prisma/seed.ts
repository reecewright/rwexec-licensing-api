import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.product.upsert({
    where: { slug: "rwexec-reservations" },
    update: { name: "RWExec Reservations" },
    create: {
      slug: "rwexec-reservations",
      name: "RWExec Reservations"
    }
  });

  console.log("Seeded product: rwexec-reservations");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
