import { cn } from "../../lib/utils";


export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
return <div className={cn("rounded-3xl border border-neutral-800 bg-neutral-900/40 p-4", className)} {...props} />
}


export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
return <h3 className={cn("text-base font-semibold", className)} {...props} />
}


export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
return <p className={cn("text-sm text-neutral-400", className)} {...props} />
}