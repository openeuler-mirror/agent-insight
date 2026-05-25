interface Props {
    text: string;
}

export function PlainRenderer({ text }: Props) {
    return (
        <pre className="sv-plain">
            <code>{text}</code>
        </pre>
    );
}
