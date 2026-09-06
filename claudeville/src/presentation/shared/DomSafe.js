export function el(tagName, options = {}, children = []) {
    const node = document.createElement(tagName);
    const {
        className,
        text,
        title,
        ariaLabel,
        dataset,
        style,
    } = options;

    if (className) {
        const classes = Array.isArray(className) ? className : String(className).split(/\s+/);
        node.classList.add(...classes.filter(Boolean));
    }
    if (text !== undefined && text !== null) {
        node.textContent = String(text);
    }
    if (title !== undefined && title !== null) {
        node.title = String(title);
    }
    if (ariaLabel !== undefined && ariaLabel !== null) {
        node.setAttribute('aria-label', String(ariaLabel));
    }
    if (dataset) {
        for (const [key, value] of Object.entries(dataset)) {
            if (value !== undefined && value !== null) {
                node.dataset[key] = String(value);
            }
        }
    }
    if (style) {
        Object.assign(node.style, style);
    }

    append(node, children);
    return node;
}

function append(parent, children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
        if (child === undefined || child === null) continue;
        parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return parent;
}

export function replaceChildren(parent, children = []) {
    parent.replaceChildren();
    append(parent, children);
    return parent;
}
