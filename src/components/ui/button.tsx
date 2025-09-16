import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";
import type { ButtonHTMLAttributes, PropsWithChildren } from "react";


const buttonVariants = cva(
"inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed",
{
variants: {
variant: {
default: "bg-white text-neutral-900 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-white dark:hover:bg-neutral-700",
ghost: "hover:bg-neutral-100 dark:hover:bg-neutral-800",
outline: "border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60",
},
size: {
sm: "h-8 px-3 text-xs",
md: "h-10 px-4 text-sm",
lg: "h-12 px-5 text-base",
},
},
defaultVariants: { variant: "default", size: "md" },
}
);


export type ButtonProps = PropsWithChildren<
ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>
>;


export function Button({ className, variant, size, ...props }: ButtonProps) {
return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}