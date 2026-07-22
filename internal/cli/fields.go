package cli

import "strings"

type fieldSelectorParser struct {
	selector string
	position int
}

func fieldSelectorIncludes(selector, target string) bool {
	parser := fieldSelectorParser{selector: selector}
	for _, path := range parser.parseList(nil, 0) {
		wildcardParent := strings.TrimSuffix(path, "/*")
		if path == "*" || path == "items" || path == target || strings.HasPrefix(path, target+"/") || strings.HasPrefix(target, path+"/") || wildcardParent != path && strings.HasPrefix(target, wildcardParent+"/") {
			return true
		}
	}
	return false
}

func (p *fieldSelectorParser) parseList(prefix []string, terminator byte) []string {
	var paths []string
	for p.position < len(p.selector) {
		p.skipSpacesAndCommas()
		if p.position >= len(p.selector) {
			break
		}
		if terminator != 0 && p.selector[p.position] == terminator {
			p.position++
			break
		}
		paths = append(paths, p.parseField(prefix)...)
	}
	return paths
}

func (p *fieldSelectorParser) parseField(prefix []string) []string {
	name := p.readName()
	if name == "" {
		p.position++
		return nil
	}
	path := append(append([]string(nil), prefix...), name)
	p.skipSpaces()
	if p.position >= len(p.selector) {
		return []string{strings.Join(path, "/")}
	}
	switch p.selector[p.position] {
	case '/':
		p.position++
		p.skipSpaces()
		return p.parseField(path)
	case '(':
		p.position++
		return p.parseList(path, ')')
	default:
		return []string{strings.Join(path, "/")}
	}
}

func (p *fieldSelectorParser) readName() string {
	start := p.position
	for p.position < len(p.selector) && !strings.ContainsRune("/(), \t\r\n", rune(p.selector[p.position])) {
		p.position++
	}
	return p.selector[start:p.position]
}

func (p *fieldSelectorParser) skipSpacesAndCommas() {
	for p.position < len(p.selector) && (p.selector[p.position] == ',' || strings.ContainsRune(" \t\r\n", rune(p.selector[p.position]))) {
		p.position++
	}
}

func (p *fieldSelectorParser) skipSpaces() {
	for p.position < len(p.selector) && strings.ContainsRune(" \t\r\n", rune(p.selector[p.position])) {
		p.position++
	}
}
