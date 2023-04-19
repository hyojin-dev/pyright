/*
 * callHierarchyProvider.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Logic that provides a list of callers or callees associated with
 * a position.
 */

import { CancellationToken, SymbolKind } from 'vscode-languageserver';
import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    Range,
} from 'vscode-languageserver-types';

import { Declaration, DeclarationType } from '../analyzer/declaration';
import * as DeclarationUtils from '../analyzer/declarationUtils';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ClassType, isClassInstance, isFunction, isInstantiableClass } from '../analyzer/types';
import {
    ClassMemberLookupFlags,
    doForEachSubtype,
    isMaybeDescriptorInstance,
    lookUpClassMember,
    lookUpObjectMember,
} from '../analyzer/typeUtils';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { getFileName } from '../common/pathUtils';
import { convertOffsetsToRange } from '../common/positionUtils';
import { rangesAreEqual } from '../common/textRange';
import { ReferencesResult } from '../languageService/referencesProvider';
import { CallNode, MemberAccessNode, NameNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import { ParseResults } from '../parser/parser';

export class CallHierarchyProvider {
    static getCallForDeclaration(
        symbolName: string,
        declaration: Declaration,
        evaluator: TypeEvaluator,
        token: CancellationToken,
        callItemUri: string
    ): CallHierarchyItem | undefined {
        throwIfCancellationRequested(token);

        if (
            declaration.type === DeclarationType.Function ||
            declaration.type === DeclarationType.Class ||
            declaration.type === DeclarationType.Alias
        ) {
            // make sure the alias is resolved to class or function
            if (declaration.type === DeclarationType.Alias) {
                const resolvedDecl = evaluator.resolveAliasDeclaration(declaration, true);
                if (!resolvedDecl) {
                    return undefined;
                }
                if (resolvedDecl.type !== DeclarationType.Function && resolvedDecl.type !== DeclarationType.Class) {
                    return undefined;
                }
            }
            const callItem: CallHierarchyItem = {
                name: symbolName,
                kind: getSymbolKind(declaration, evaluator),
                uri: callItemUri,
                range: declaration.range,
                selectionRange: declaration.range,
            };
            return callItem;
        }

        return undefined;
    }

    static getIncomingCallsForDeclaration(
        filePath: string,
        symbolName: string,
        declaration: Declaration,
        parseResults: ParseResults,
        evaluator: TypeEvaluator,
        token: CancellationToken
    ): CallHierarchyIncomingCall[] | undefined {
        throwIfCancellationRequested(token);

        const callFinder = new FindIncomingCallTreeWalker(
            filePath,
            symbolName,
            declaration,
            parseResults,
            evaluator,
            token
        );

        const incomingCalls = callFinder.findCalls();

        return incomingCalls.length > 0 ? incomingCalls : undefined;
    }

    static getOutgoingCallsForDeclaration(
        declaration: Declaration,
        parseResults: ParseResults,
        evaluator: TypeEvaluator,
        token: CancellationToken
    ): CallHierarchyOutgoingCall[] | undefined {
        throwIfCancellationRequested(token);

        // Find the parse node root corresponding to the function or class.
        let parseRoot: ParseNode | undefined;
        const resolvedDecl = evaluator.resolveAliasDeclaration(declaration, /* resolveLocalNames */ true);
        if (!resolvedDecl) {
            return undefined;
        }
        if (resolvedDecl.type === DeclarationType.Function) {
            parseRoot = resolvedDecl.node;
        } else if (resolvedDecl.type === DeclarationType.Class) {
            // Look up the __init__ method for this class.
            const classType = evaluator.getTypeForDeclaration(resolvedDecl)?.type;
            if (classType && isInstantiableClass(classType)) {
                // Don't perform a recursive search of parent classes in this
                // case because we don't want to find an inherited __init__
                // method defined in a different module.
                const initMethodMember = lookUpClassMember(
                    classType,
                    '__init__',
                    ClassMemberLookupFlags.SkipInstanceVariables |
                        ClassMemberLookupFlags.SkipObjectBaseClass |
                        ClassMemberLookupFlags.SkipBaseClasses
                );
                if (initMethodMember) {
                    const initMethodType = evaluator.getTypeOfMember(initMethodMember);
                    if (initMethodType && isFunction(initMethodType)) {
                        const initDecls = initMethodMember.symbol.getDeclarations();
                        if (initDecls && initDecls.length > 0) {
                            const primaryInitDecl = initDecls[0];
                            if (primaryInitDecl.type === DeclarationType.Function) {
                                parseRoot = primaryInitDecl.node;
                            }
                        }
                    }
                }
            }
        }

        if (!parseRoot) {
            return undefined;
        }

        const callFinder = new FindOutgoingCallTreeWalker(parseRoot, parseResults, evaluator, token);

        const outgoingCalls = callFinder.findCalls();

        return outgoingCalls.length > 0 ? outgoingCalls : undefined;
    }

    static getTargetDeclaration(
        referencesResult: ReferencesResult,
        filePath: string
    ): { targetDecl: Declaration; callItemUri: string; symbolName: string } {
        // If there's more than one declaration, pick the target one.
        // We'll always prefer one with a declared type, and we'll always
        // prefer later declarations.
        const declarations = referencesResult.declarations;
        const node = referencesResult.nodeAtOffset;
        let targetDecl = declarations[0];
        for (const decl of declarations) {
            if (DeclarationUtils.hasTypeForDeclaration(decl) || !DeclarationUtils.hasTypeForDeclaration(targetDecl)) {
                if (decl.type === DeclarationType.Function || decl.type === DeclarationType.Class) {
                    targetDecl = decl;

                    // If the specified node is an exact match, use this declaration
                    // as the primary even if it's not the last.
                    if (decl.node === node) {
                        break;
                    }
                }
            }
        }
        let symbolName;

        // Although the LSP specification requires a URI, we are using a file path
        // here because it is converted to the proper URI in LanguageServerBase.
        // This simplifies our code and ensures compatibility with the LSP specification.
        let callItemUri;
        if (targetDecl.type === DeclarationType.Alias) {
            symbolName = (referencesResult.nodeAtOffset as NameNode).value;
            callItemUri = filePath;
        } else {
            symbolName = DeclarationUtils.getNameFromDeclaration(targetDecl) || referencesResult.symbolNames[0];
            callItemUri = targetDecl.path;
        }
        return { targetDecl, callItemUri, symbolName };
    }
}

class FindOutgoingCallTreeWalker extends ParseTreeWalker {
    private _outgoingCalls: CallHierarchyOutgoingCall[] = [];

    constructor(
        private _parseRoot: ParseNode,
        private _parseResults: ParseResults,
        private _evaluator: TypeEvaluator,
        private _cancellationToken: CancellationToken
    ) {
        super();
    }

    findCalls(): CallHierarchyOutgoingCall[] {
        this.walk(this._parseRoot);
        return this._outgoingCalls;
    }

    override visitCall(node: CallNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        let nameNode: NameNode | undefined;

        if (node.leftExpression.nodeType === ParseNodeType.Name) {
            nameNode = node.leftExpression;
        } else if (node.leftExpression.nodeType === ParseNodeType.MemberAccess) {
            nameNode = node.leftExpression.memberName;
        }

        if (nameNode) {
            const declarations = this._evaluator.getDeclarationsForNameNode(nameNode);

            if (declarations) {
                // TODO - it would be better if we could match the call to the
                // specific declaration (e.g. a specific overload of a property
                // setter vs getter). For now, add callees for all declarations.
                declarations.forEach((decl) => {
                    this._addOutgoingCallForDeclaration(nameNode!, decl);
                });
            }
        }

        return true;
    }

    override visitMemberAccess(node: MemberAccessNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        // Determine whether the member corresponds to a property.
        // If so, we'll treat it as a function call for purposes of
        // finding outgoing calls.
        const leftHandType = this._evaluator.getType(node.leftExpression);
        if (leftHandType) {
            doForEachSubtype(leftHandType, (subtype) => {
                let baseType = subtype;

                // This could be a bound TypeVar (e.g. used for "self" and "cls").
                baseType = this._evaluator.makeTopLevelTypeVarsConcrete(baseType);

                if (!isClassInstance(baseType)) {
                    return;
                }

                const memberInfo = lookUpObjectMember(baseType, node.memberName.value);
                if (!memberInfo) {
                    return;
                }

                const memberType = this._evaluator.getTypeOfMember(memberInfo);
                const propertyDecls = memberInfo.symbol.getDeclarations();

                if (!memberType) {
                    return;
                }

                if (isClassInstance(memberType) && ClassType.isPropertyClass(memberType)) {
                    propertyDecls.forEach((decl) => {
                        this._addOutgoingCallForDeclaration(node.memberName, decl);
                    });
                }
            });
        }

        return true;
    }

    private _addOutgoingCallForDeclaration(nameNode: NameNode, declaration: Declaration) {
        const resolvedDecl = this._evaluator.resolveAliasDeclaration(declaration, /* resolveLocalNames */ true);
        if (!resolvedDecl) {
            return;
        }

        if (resolvedDecl.type !== DeclarationType.Function && resolvedDecl.type !== DeclarationType.Class) {
            return;
        }

        const callDest: CallHierarchyItem = {
            name: nameNode.value,
            kind: getSymbolKind(resolvedDecl, this._evaluator),
            uri: resolvedDecl.path,
            range: resolvedDecl.range,
            selectionRange: resolvedDecl.range,
        };

        // Is there already a call recorded for this destination? If so,
        // we'll simply add a new range. Otherwise, we'll create a new entry.
        let outgoingCall: CallHierarchyOutgoingCall | undefined = this._outgoingCalls.find(
            (outgoing) => outgoing.to.uri === callDest.uri && rangesAreEqual(outgoing.to.range, callDest.range)
        );

        if (!outgoingCall) {
            outgoingCall = {
                to: callDest,
                fromRanges: [],
            };
            this._outgoingCalls.push(outgoingCall);
        }

        if (outgoingCall && outgoingCall.to.name !== nameNode.value) {
            // If both the function and its alias are called in the same function,
            // the name of the call item will be the resolved declaration name, not the alias.
            outgoingCall.to.name = DeclarationUtils.getNameFromDeclaration(resolvedDecl) ?? nameNode.value;
        }

        const fromRange: Range = convertOffsetsToRange(
            nameNode.start,
            nameNode.start + nameNode.length,
            this._parseResults.tokenizerOutput.lines
        );
        outgoingCall.fromRanges.push(fromRange);
    }
}

class FindIncomingCallTreeWalker extends ParseTreeWalker {
    private _incomingCalls: CallHierarchyIncomingCall[] = [];

    constructor(
        private _filePath: string,
        private _symbolName: string,
        private _declaration: Declaration,
        private _parseResults: ParseResults,
        private _evaluator: TypeEvaluator,
        private _cancellationToken: CancellationToken
    ) {
        super();
    }

    findCalls(): CallHierarchyIncomingCall[] {
        this.walk(this._parseResults.parseTree);
        return this._incomingCalls;
    }

    override visitCall(node: CallNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        let nameNode: NameNode | undefined;

        if (node.leftExpression.nodeType === ParseNodeType.Name) {
            nameNode = node.leftExpression;
        } else if (node.leftExpression.nodeType === ParseNodeType.MemberAccess) {
            nameNode = node.leftExpression.memberName;
        }

        // Don't bother doing any more work if the name doesn't match.
        if (nameNode && nameNode.value === this._symbolName) {
            const declarations = this._evaluator.getDeclarationsForNameNode(nameNode);

            if (declarations) {
                const resolvedDecls = declarations
                    .map((decl) => {
                        return this._evaluator.resolveAliasDeclaration(decl, /* resolveLocalNames */ true);
                    })
                    .filter((decl) => decl !== undefined);
                if (this._declaration.type === DeclarationType.Alias) {
                    const resolvedCurDecls = this._evaluator.resolveAliasDeclaration(
                        this._declaration,
                        /* resolveLocalNames */ true
                    );
                    if (
                        resolvedCurDecls &&
                        resolvedDecls.some((decl) => DeclarationUtils.areDeclarationsSame(decl!, resolvedCurDecls))
                    ) {
                        this._addIncomingCallForDeclaration(nameNode!);
                    }
                } else if (
                    resolvedDecls.some((decl) => DeclarationUtils.areDeclarationsSame(decl!, this._declaration))
                ) {
                    this._addIncomingCallForDeclaration(nameNode!);
                }
            }
        }

        return true;
    }

    override visitMemberAccess(node: MemberAccessNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        if (node.memberName.value === this._symbolName) {
            // Determine whether the member corresponds to a property.
            // If so, we'll treat it as a function call for purposes of
            // finding outgoing calls.
            const leftHandType = this._evaluator.getType(node.leftExpression);
            if (leftHandType) {
                doForEachSubtype(leftHandType, (subtype) => {
                    let baseType = subtype;

                    // This could be a bound TypeVar (e.g. used for "self" and "cls").
                    baseType = this._evaluator.makeTopLevelTypeVarsConcrete(baseType);

                    if (!isClassInstance(baseType)) {
                        return;
                    }

                    const memberInfo = lookUpObjectMember(baseType, node.memberName.value);
                    if (!memberInfo) {
                        return;
                    }

                    const memberType = this._evaluator.getTypeOfMember(memberInfo);
                    const propertyDecls = memberInfo.symbol.getDeclarations();

                    if (!memberType) {
                        return;
                    }

                    if (propertyDecls.some((decl) => DeclarationUtils.areDeclarationsSame(decl!, this._declaration))) {
                        this._addIncomingCallForDeclaration(node.memberName);
                    }
                });
            }
        }

        return true;
    }

    private _addIncomingCallForDeclaration(nameNode: NameNode) {
        const executionNode = ParseTreeUtils.getExecutionScopeNode(nameNode);
        if (!executionNode) {
            return;
        }

        let callSource: CallHierarchyItem;
        if (executionNode.nodeType === ParseNodeType.Module) {
            const moduleRange = convertOffsetsToRange(0, 0, this._parseResults.tokenizerOutput.lines);
            const fileName = getFileName(this._filePath);

            callSource = {
                name: `(module) ${fileName}`,
                kind: SymbolKind.Module,
                uri: this._filePath,
                range: moduleRange,
                selectionRange: moduleRange,
            };
        } else if (executionNode.nodeType === ParseNodeType.Lambda) {
            const lambdaRange = convertOffsetsToRange(
                executionNode.start,
                executionNode.start + executionNode.length,
                this._parseResults.tokenizerOutput.lines
            );

            callSource = {
                name: '(lambda)',
                kind: SymbolKind.Function,
                uri: this._filePath,
                range: lambdaRange,
                selectionRange: lambdaRange,
            };
        } else {
            const functionRange = convertOffsetsToRange(
                executionNode.name.start,
                executionNode.name.start + executionNode.name.length,
                this._parseResults.tokenizerOutput.lines
            );

            callSource = {
                name: executionNode.name.value,
                kind: SymbolKind.Function,
                uri: this._filePath,
                range: functionRange,
                selectionRange: functionRange,
            };
        }

        // Is there already a call recorded for this caller? If so,
        // we'll simply add a new range. Otherwise, we'll create a new entry.
        let incomingCall: CallHierarchyIncomingCall | undefined = this._incomingCalls.find(
            (incoming) => incoming.from.uri === callSource.uri && rangesAreEqual(incoming.from.range, callSource.range)
        );

        if (!incomingCall) {
            incomingCall = {
                from: callSource,
                fromRanges: [],
            };
            this._incomingCalls.push(incomingCall);
        }

        const fromRange: Range = convertOffsetsToRange(
            nameNode.start,
            nameNode.start + nameNode.length,
            this._parseResults.tokenizerOutput.lines
        );
        incomingCall.fromRanges.push(fromRange);
    }
}

function getSymbolKind(declaration: Declaration, evaluator: TypeEvaluator): SymbolKind {
    let symbolKind: SymbolKind;

    switch (declaration.type) {
        case DeclarationType.Class:
        case DeclarationType.SpecialBuiltInClass:
            symbolKind = SymbolKind.Class;
            break;

        case DeclarationType.Function:
            if (declaration.isMethod) {
                const declType = evaluator.getTypeForDeclaration(declaration)?.type;
                if (declType && isMaybeDescriptorInstance(declType, /* requireSetter */ false)) {
                    symbolKind = SymbolKind.Property;
                } else {
                    symbolKind = SymbolKind.Method;
                }
            } else {
                symbolKind = SymbolKind.Function;
            }
            break;

        default:
            symbolKind = SymbolKind.Function;
            break;
    }

    return symbolKind;
}
